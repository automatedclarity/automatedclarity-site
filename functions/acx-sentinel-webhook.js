import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const LC_BASE = "https://services.leadconnectorhq.com";
const LC_VERSION = "2021-07-28";

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
};

const toDateOnly = (d = new Date()) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}

  const contactId =
    pick(body, ["contact_id", "contactId"]) ||
    pick(body?.contact, ["id", "contact_id"]);

  if (!contactId) {
    return json(400, { ok: false, error: "Missing contact_id in payload", received: body });
  }

  const apiKey = process.env.LC_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: "Missing LC_API_KEY env var" });

  const runId = pick(body, ["run_id", "runId"]);
  const locationId = pick(body, ["location_id", "locationId"]);
  const locationName = pick(body, ["location_name", "locationName"]);
  const status = pick(body, ["status", "console_status", "health_status"]);
  const reason = pick(body, ["reason", "last_reason", "fail_reason"]);
  const failStreak = String(pick(body, ["fail_streak", "failStreak", "streak"]) || "");

  if (!locationId) {
    return json(400, { ok: false, error: "Missing location_id in payload", received: body });
  }

  const lastOkDate = toDateOnly(new Date());
  const startedAtStr = new Date().toISOString();

  // ---- 1) Read LOCATION custom field definitions to get IDs (deterministic) ----
  const fieldsResp = await fetch(
    `${LC_BASE}/locations/${encodeURIComponent(locationId)}/customFields`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: LC_VERSION,
        Accept: "application/json",
      },
    }
  );

  const fieldsText = await fieldsResp.text();
  if (!fieldsResp.ok) {
    return json(fieldsResp.status, {
      ok: false,
      error: "Custom fields list read failed",
      status: fieldsResp.status,
      response: fieldsText,
      location_id: locationId,
    });
  }

  let fieldsJson = {};
  try { fieldsJson = JSON.parse(fieldsText); } catch {}

  const defs =
    fieldsJson?.customFields ||
    fieldsJson?.customField ||
    fieldsJson?.fields ||
    [];

  // Map: LOWERCASED fieldKey -> id (fixes Acx_* vs acx_* mismatches)
  const keyToId = new Map();
  for (const f of defs) {
    const rawKey = f.fieldKey || f.key || f.name;
    const id = f.id;
    if (rawKey && id) keyToId.set(String(rawKey).toLowerCase(), id);
  }

  const setCF = (fieldKey, value) => {
    const id = keyToId.get(String(fieldKey).toLowerCase());
    if (!id) return null;
    return { id, value: String(value ?? "") };
  };

  const customField = [
    setCF("acx_test_run_id", runId),
    setCF("acx_console_location_id", locationId),
    setCF("acx_console_location_name", locationName),
    setCF("acx_console_status", status),
    setCF("acx_console_last_reason", reason),
    setCF("acx_console_fail_streak", failStreak),
    setCF("acx_console_last_ok", lastOkDate),

    // Started At (string)
    setCF("acx_started_at_str", startedAtStr),
  ].filter(Boolean);

  // Hard-fail if started_at_str can't be found (so it never silently "works")
  if (!keyToId.get("acx_started_at_str")) {
    return json(422, {
      ok: false,
      error: "Field key not found in location customFields (case-insensitive lookup still failed).",
      missing_key: "acx_started_at_str",
      location_id: locationId,
    });
  }

  const updateResp = await fetch(`${LC_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: LC_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ customField }),
  });

  const updateText = await updateResp.text();
  if (!updateResp.ok) {
    return json(updateResp.status, {
      ok: false,
      error: "Contact update failed",
      status: updateResp.status,
      response: updateText,
      sent: { customField },
      contact_id: contactId,
      location_id: locationId,
    });
  }

  return json(200, {
  ok: true,
  contact_id: contactId,
  location_id: locationId,
  wrote_count: customField.length,
  wrote_field_ids: customField.map((x) => x.id),
  has_started_at_str_id: Boolean(keyToId.get("acx_started_at_str")),
  started_at_str_value: startedAtStr,
});
