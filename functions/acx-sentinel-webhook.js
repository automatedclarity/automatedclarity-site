// netlify/functions/acx-sentinel-webhook.js
// ACX Sentinel → GHL Contact Custom Field writer
// ✅ NO customFields fetch (no /locations/{id}/customFields calls)
// ✅ Uses env-provided Custom Field IDs (CF_*)
// ✅ Requires contact_id (keeps this deterministic + avoids search scope issues)

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  },
  body: JSON.stringify(obj),
});

const pickHeader = (headers, name) => {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};

const safeJsonParse = (s) => {
  try {
    return { ok: true, value: JSON.parse(s || "{}") };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing_env_${name}`);
  return v;
};

const asNumber = (v, fallback = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
};

const ghaHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Version: API_VERSION,
  "Content-Type": "application/json",
  Accept: "application/json",
});

async function httpJson(method, url, token, bodyObj) {
  const res = await fetch(url, {
    method,
    headers: ghaHeaders(token),
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed, raw: text };
}

// GET contact details (to enforce location match when you have GHL_LOCATION_ID set)
async function ghlGetContact({ token, contactId }) {
  // GHL v2: GET /contacts/{id}
  const url = `${API_BASE}/contacts/${encodeURIComponent(contactId)}`;
  return await httpJson("GET", url, token);
}

// UPDATE contact (customFields only; DO NOT include locationId/id in body)
async function ghlUpdateContactCustomFields({ token, contactId, customFields }) {
  const url = `${API_BASE}/contacts/${encodeURIComponent(contactId)}`;
  return await httpJson("PUT", url, token, { customFields });
}

exports.handler = async (event) => {
  try {
    // --- optional webhook secret gate (recommended) ---
    const secret = process.env.ACX_WEBHOOK_SECRET;
    if (secret) {
      const provided =
        pickHeader(event.headers, "x-acx-secret") ||
        pickHeader(event.headers, "x-webhook-secret") ||
        (event.queryStringParameters && event.queryStringParameters.secret);

      if (!provided || provided !== secret) {
        return json(401, { ok: false, error: "unauthorized" });
      }
    }

    if ((event.httpMethod || "").toUpperCase() !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const parsed = safeJsonParse(event.body);
    if (!parsed.ok) return json(400, { ok: false, error: "invalid_json" });

    const body = parsed.value || {};

    // --- required input (deterministic) ---
    const contactId = body.contact_id || body.contactId || body.id;
    if (!contactId) {
      return json(400, { ok: false, error: "missing_contact_identifier", required: ["contact_id"] });
    }

    // --- numeric fail streak (MUST BE NUMBER) ---
    const failStreak = asNumber(body.acx_console_fail_streak, 0);

    // --- values to write ---
    const locationName = String(body.acx_console_location_name || "");
    const lastReason = String(body.acx_console_last_reason || "");
    const startedAtStr = String(body.acx_started_at_str || "");

    // --- env ---
    const token = requireEnv("GHL_API_KEY");

    // Custom Field IDs (these are the numeric/uuid IDs from GHL settings)
    // Put these in Netlify env vars.
    const CF_LOCATION_NAME = requireEnv("CF_ACX_CONSOLE_LOCATION_NAME");
    const CF_FAIL_STREAK = requireEnv("CF_ACX_CONSOLE_FAIL_STREAK");
    const CF_LAST_REASON = requireEnv("CF_ACX_CONSOLE_LAST_REASON");
    const CF_STARTED_AT_STR = requireEnv("CF_ACX_STARTED_AT_STR");

    // Optional: enforce the contact belongs to the expected location (prevents writing into wrong subaccount)
    const expectedLocationId = process.env.GHL_LOCATION_ID;

    if (expectedLocationId) {
      const getRes = await ghlGetContact({ token, contactId });
      if (!getRes.ok) {
        return json(502, {
          ok: false,
          error: "contact_fetch_failed",
          status: getRes.status,
          body: getRes.body,
        });
      }

      const contactLocationId =
        getRes.body?.contact?.locationId ||
        getRes.body?.locationId ||
        getRes.body?.contact?.location_id ||
        null;

      if (contactLocationId && contactLocationId !== expectedLocationId) {
        return json(409, {
          ok: false,
          error: "location_mismatch",
          expectedLocationId,
          contactLocationId,
          contactId,
        });
      }
    }

    // Build ONLY the fields we actually have values for (avoid blank overwrites if you don’t want them)
    const customFields = [];

    if (locationName) customFields.push({ id: CF_LOCATION_NAME, value: locationName });
    customFields.push({ id: CF_FAIL_STREAK, value: failStreak }); // ALWAYS numeric
    if (lastReason) customFields.push({ id: CF_LAST_REASON, value: lastReason });
    if (startedAtStr) customFields.push({ id: CF_STARTED_AT_STR, value: startedAtStr });

    const updRes = await ghlUpdateContactCustomFields({ token, contactId, customFields });

    if (!updRes.ok) {
      return json(502, {
        ok: false,
        error: "ghl_update_failed",
        status: updRes.status,
        body: updRes.body,
      });
    }

    return json(200, {
      ok: true,
      contactId,
      failStreak,
      fieldIdsUsed: {
        location_name: CF_LOCATION_NAME,
        fail_streak: CF_FAIL_STREAK,
        last_reason: CF_LAST_REASON,
        started_at_str: CF_STARTED_AT_STR,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: "internal_error", message: String(e) });
  }
};
