// functions/acx_ingest_repull_v1.js
import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj, null, 2), {
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

  const locationId = pick(body, ["location_id", "locationId"]);

  if (!contactId) {
    return json(400, { ok: false, error: "Missing contact_id", received: body });
  }
  if (!locationId) {
    return json(400, { ok: false, error: "Missing location_id", received: body });
  }

  const apiKey = process.env.LC_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: "Missing LC_API_KEY env var" });

  // inbound values
  const runId = pick(body, ["run_id", "runId"]);
  const locationName = pick(body, ["location_name", "locationName"]);
  const status = pick(body, ["status", "console_status", "health_status"]);
  const reason = pick(body, ["reason", "last_reason", "fail_reason"]);
  const failStreak = String(pick(body, ["fail_streak", "failStreak", "streak"]) || "");

  const lastOkDate = toDateOnly(new Date());

  // IMPORTANT: deterministic timestamp (string) we want to see in email later
  // Keep it ISO for storage; you can format on display.
  const startedAtStr = new Date().toISOString();

  // 1) Pull location custom field definitions (this is the source of truth for IDs)
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
      error: "Failed to read location customFields",
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

  // Build map of ALL keys we can see
  const keyToId = new Map();
  const seenKeys = [];
  for (const f of defs) {
    const rawKey = f.fieldKey || f.key || f.name;
    const id = f.id;
    if (!rawKey || !id) continue;
    const k = String(rawKey).toLowerCase();
    keyToId.set(k, id);
    seenKeys.push(rawKey);
  }

  // helper
  const setCF = (fieldKey, value) => {
    const id = keyToId.get(String(fieldKey).toLowerCase());
    if (!id) return null;
    return { id, value: String(value ?? "") };
  };

  // keys we REQUIRE to exist for this to be considered “working”
  const REQUIRED_KEYS = [
    "acx_console_location_id",
    "acx_console_location_name",
    "acx_console_status",
    "acx_console_last_reason",
    "acx_console_fail_streak",
    "acx_console_last_ok",
    "acx_started_at_str",
    "acx_test_run_id",
  ];

  const missing = REQUIRED_KEYS.filter((k) => !keyToId.get(k.toLowerCase()));

  // If any required key is missing, STOP and show exactly what GHL/LC thinks the keys are.
  // This eliminates guessing forever.
  if (missing.length) {
    return json(422, {
      ok: false,
      error: "Required custom field key(s) missing for this location",
      location_id: locationId,
      missing_keys: missing,
      seen_keys_sample: seenKeys.slice(0, 80),
      note:
        "Fix is NOT code. Fix is your custom field KEY names (or which location you’re testing). Keys must match exactly (case-insensitive).",
    });
  }

  const customField = [
    setCF("acx_test_run_id", runId),
    setCF("acx_console_location_id", locationId),
    setCF("acx_console_location_name", locationName),
    setCF("acx_console_status", status),
    setCF("acx_console_last_reason", reason),
    setCF("acx_console_fail_streak", failStreak),
    setCF("acx_console_last_ok", lastOkDate),
    setCF("acx_started_at_str", startedAtStr),
  ].filter(Boolean);

  // 2) Update contact
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
      contact_id: contactId,
      location_id: locationId,
      attempted_keys: REQUIRED_KEYS,
    });
  }

  return json(200, {
    ok: true,
    message: "Updated contact custom fields",
    contact_id: contactId,
    location_id: locationId,
    started_at_str: startedAtStr,
    wrote_count: customField.length,
    wrote_field_ids: customField.map((x) => x.id),
  });
};
