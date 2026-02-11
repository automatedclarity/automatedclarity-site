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
  try {
    body = await req.json();
  } catch {}

  const contactId =
    pick(body, ["contact_id", "contactId"]) ||
    pick(body?.contact, ["id", "contact_id"]);

  if (!contactId) {
    return json(400, {
      ok: false,
      error: "Missing contact_id in payload",
      received: body,
    });
  }

  const apiKey = process.env.LC_API_KEY;
  if (!apiKey) {
    return json(500, { ok: false, error: "Missing LC_API_KEY env var" });
  }

  // ---- Normalize inbound values (what you want on the contact) ----
  const runId = pick(body, ["run_id", "runId"]);
  const locationId = pick(body, ["location_id", "locationId"]);
  const locationName = pick(body, ["location_name", "locationName"]);
  const status = pick(body, ["status", "console_status", "health_status"]);
  const reason = pick(body, ["reason", "last_reason", "fail_reason"]);
  const failStreak = String(
    pick(body, ["fail_streak", "failStreak", "streak"]) || ""
  );

  if (!locationId) {
    return json(400, { ok: false, error: "Missing location_id in payload" });
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
  try {
    fieldsJson = JSON.parse(fieldsText);
  } catch {}

  const defs =
    fieldsJson?.customFields ||
    fieldsJson?.customField ||
    fieldsJson?.fields ||
    [];

  // Map: fieldKey -> id
  const keyToId = new Map();
  for (const f of defs) {
    const key = f.fieldKey || f.key || f.name;
    if (key && f.id) keyToId.set(key, f.id);
  }

  // Helper: write by ID; also logs missing field keys to Netlify logs
  const setCF = (fieldKey, value) => {
    const id = keyToId.get(fieldKey);
    if (!id) {
      console.log("MISSING FIELD KEY:", fieldKey, "locationId:", locationId);
      return null;
    }
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

    // THIS is the one you’re missing in the location (most likely)
    setCF("acx_started_at_str", startedAtStr),
  ].filter(Boolean);

  // Hard-fail if started_at_str is missing so you never “think it worked”
  const startedAtId = keyToId.get("acx_started_at_str");
  if (!startedAtId) {
    return json(422, {
      ok: false,
      error:
        "Custom field key 'acx_started_at_str' not found in this location’s custom field definitions.",
      location_id: locationId,
      fix:
        "Create Contact custom field with key/name exactly: acx_started_at_str in THIS sub-account/location.",
      available_keys_sample: Array.from(keyToId.keys()).slice(0, 50),
    });
  }

  if (customField.length === 0) {
    return json(422, {
      ok: false,
      error: "No matching custom field IDs found for your ACX keys on this location.",
      location_id: locationId,
      received: body,
    });
  }

  // ---- 2) Update contact with correct schema ----
  const updateResp = await fetch(
    `${LC_BASE}/contacts/${encodeURIComponent(contactId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: LC_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ customField }),
    }
  );

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
    message: "ACX Sentinel updated contact fields (location-ID-based)",
    contact_id: contactId,
    location_id: locationId,
    wrote_count: customField.length,
    wrote_ids: customField.map((x) => x.id),
  });
};
