// netlify/functions/acx-sentinel-webhook.js
//
// ACX Sentinel Webhook — SELF-HEALING Custom Field ID Resolver
// - No manual CF_* env vars required
// - Resolves custom field IDs from GHL by field key/name at runtime
// - Writes values ONLY after:
//   1) contact exists
//   2) custom field IDs resolved
//   3) PUT update succeeds
//
// Required env:
// - GHL_API_KEY
// - GHL_LOCATION_ID
//
// Optional env:
// - ACX_CF_CACHE_TTL_MS (default 10 minutes)

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

const CACHE_TTL_MS = Number(process.env.ACX_CF_CACHE_TTL_MS || 10 * 60 * 1000);

let cached = {
  at: 0,
  map: null, // { acx_console_location_name: 'id', ... }
};

export async function handler(event) {
  const json = (code, obj) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  });

  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
    if (!GHL_API_KEY || !GHL_LOCATION_ID) {
      return json(500, { ok: false, error: "missing_env", missing: { GHL_API_KEY: !!GHL_API_KEY, GHL_LOCATION_ID: !!GHL_LOCATION_ID } });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { ok: false, error: "invalid_json" }); }

    const contactId = body.contact_id || body.contactId;
    if (!contactId) return json(400, { ok: false, error: "missing_contact_id" });

    const failStreak = Number(body.acx_console_fail_streak);
    if (!Number.isFinite(failStreak)) {
      return json(400, { ok: false, error: "invalid_fail_streak_number", received: body.acx_console_fail_streak });
    }

    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // 1) PROVE contact exists
    const getRes = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}`, { method: "GET", headers });
    const getText = await getRes.text();
    const getJson = safeParse(getText);
    if (!getRes.ok) {
      return json(404, { ok: false, error: "contact_not_found_by_id", upstream: { status: getRes.status, body: getJson ?? getText } });
    }

    const contactLocationId =
      getJson?.contact?.locationId || getJson?.locationId || null;

    if (contactLocationId && String(contactLocationId) !== String(GHL_LOCATION_ID)) {
      return json(409, {
        ok: false,
        error: "location_mismatch",
        expectedLocationId: GHL_LOCATION_ID,
        contactLocationId,
        contactId,
      });
    }

    // 2) Resolve Custom Field IDs (self-heal)
    const cfMap = await resolveCustomFieldIds(headers);

    // 3) Build update payload
    const customFields = [
      { id: cfMap.acx_console_location_name, value: String(body.acx_console_location_name || "") },
      { id: cfMap.acx_console_fail_streak, value: failStreak }, // NUMBER ONLY
      { id: cfMap.acx_console_last_reason, value: String(body.acx_console_last_reason || "") },
      { id: cfMap.acx_started_at_str, value: String(body.acx_started_at_str || "") },
    ];

    // 4) PUT update — IMPORTANT: body contains ONLY customFields
    const putRes = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ customFields }),
    });

    const putText = await putRes.text();
    const putJson = safeParse(putText);
    if (!putRes.ok) {
      return json(502, {
        ok: false,
        error: "update_failed",
        upstream: { status: putRes.status, body: putJson ?? putText },
        fieldIds: cfMap,
      });
    }

    return json(200, {
      ok: true,
      locationId: GHL_LOCATION_ID,
      contactId,
      failStreak,
      fieldIds: cfMap,
    });
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "internal_error", message: String(e) }),
    };
  }
}

// ---- Custom Field Resolver ----
// We search GHL custom fields and map by a strict key list.
// If your account has duplicates, we pick the FIRST exact match by "fieldKey" then by "name".

async function resolveCustomFieldIds(headers) {
  const now = Date.now();
  if (cached.map && now - cached.at < CACHE_TTL_MS) return cached.map;

  // Endpoint that returns custom fields (LeadConnector/GHL)
  // NOTE: Some accounts return {customFields:[...]} and others {fields:[...]}.
  const res = await fetch(`${BASE}/custom-fields/`, { method: "GET", headers });
  const text = await res.text();
  const data = safeParse(text);

  if (!res.ok || !data) {
    throw new Error(`custom_fields_fetch_failed status=${res.status} body=${text?.slice(0, 200)}`);
  }

  const list = data.customFields || data.fields || data.custom_fields || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`custom_fields_empty`);
  }

  // What we need (keys + fallback names)
  const targets = [
    { key: "acx_console_location_name", names: ["acx_console_location_name", "ACX Console Location Name", "Console Location Name"] },
    { key: "acx_console_fail_streak", names: ["acx_console_fail_streak", "ACX Console Fail Streak", "Console Fail Streak"] },
    { key: "acx_console_last_reason", names: ["acx_console_last_reason", "ACX Console Last Reason", "Console Last Reason"] },
    { key: "acx_started_at_str", names: ["acx_started_at_str", "ACX Started At Str", "Started At Str"] },
  ];

  const map = {};

  for (const t of targets) {
    const exactKey = list.find((f) => norm(f.fieldKey) === t.key);
    const exactName = list.find((f) => t.names.includes(String(f.name || "").trim()));
    const hit = exactKey || exactName;

    if (!hit || !hit.id) {
      throw new Error(`custom_field_not_found:${t.key}`);
    }
    map[t.key] = hit.id;
  }

  cached = { at: now, map };
  return map;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function norm(v) {
  return String(v || "").trim();
}
