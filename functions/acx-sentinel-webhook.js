// netlify/functions/acx-sentinel-webhook.js

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "method_not_allowed" }),
      };
    }

    const GHL_API_KEY = process.env.GHL_API_KEY;      // pit-...
    if (!GHL_API_KEY) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "missing_env", missing: ["GHL_API_KEY"] }),
      };
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "invalid_json" }),
      };
    }

    const contactId = body.contact_id || body.contactId || null;
    if (!contactId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "missing_contact_id" }),
      };
    }

    const failStreakNum = Number(body.acx_console_fail_streak);
    if (!Number.isFinite(failStreakNum)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "invalid_fail_streak_number" }),
      };
    }

    // REQUIRED custom field IDs (set these in Netlify env)
    const CF_ACX_CONSOLE_LOCATION_NAME = process.env.CF_ACX_CONSOLE_LOCATION_NAME;
    const CF_ACX_CONSOLE_FAIL_STREAK   = process.env.CF_ACX_CONSOLE_FAIL_STREAK;
    const CF_ACX_CONSOLE_LAST_REASON   = process.env.CF_ACX_CONSOLE_LAST_REASON;
    const CF_ACX_STARTED_AT_STR        = process.env.CF_ACX_STARTED_AT_STR;

    const missing = [];
    if (!CF_ACX_CONSOLE_LOCATION_NAME) missing.push("CF_ACX_CONSOLE_LOCATION_NAME");
    if (!CF_ACX_CONSOLE_FAIL_STREAK)   missing.push("CF_ACX_CONSOLE_FAIL_STREAK");
    if (!CF_ACX_CONSOLE_LAST_REASON)   missing.push("CF_ACX_CONSOLE_LAST_REASON");
    if (!CF_ACX_STARTED_AT_STR)        missing.push("CF_ACX_STARTED_AT_STR");

    if (missing.length) {
      // Stop here with a clean, explicit error. No more undefined IDs.
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "missing_custom_field_ids", missing }),
      };
    }

    const customFields = [
      { id: CF_ACX_CONSOLE_LOCATION_NAME, value: String(body.acx_console_location_name || "") },
      { id: CF_ACX_CONSOLE_FAIL_STREAK,   value: failStreakNum }, // NUMBER
      { id: CF_ACX_CONSOLE_LAST_REASON,   value: String(body.acx_console_last_reason || "") },
      { id: CF_ACX_STARTED_AT_STR,        value: String(body.acx_started_at_str || "") },
    ];

    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // IMPORTANT: payload must NOT include locationId/id (your 422 proved that)
    const updatePayload = { customFields };

    const updateUrl = `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`;

    const res = await fetch(updateUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(updatePayload),
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          error: "update_failed",
          upstream: { status: res.status, body: json || text },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, contactId, failStreak: failStreakNum }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "internal_error", message: String(err) }),
    };
  }
}
