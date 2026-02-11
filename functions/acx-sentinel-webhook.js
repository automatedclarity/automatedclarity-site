// netlify/functions/acx-sentinel-webhook.js
//
// ACX SENTINEL — LOCKED DIAGNOSTIC/PRODUCTION VERSION
// Objective: deterministic write of Sentinel ingest fields into GHL contact custom fields.
// Guarantees:
// - NEVER returns ok:true unless:
//   (1) contact exists (GET /contacts/:id returns 200)
//   (2) custom field IDs are present (env vars set)
//   (3) update succeeds (PUT /contacts/:id returns 2xx)
// - Returns locationId + cf_ids_present + upstream statuses so you can prove correctness.
//
// Requirements (Netlify Env Vars, ALL SCOPES):
// - GHL_API_KEY  = pit-xxxxxxxxxxxxxxxxxxxxxxxx
// - GHL_LOCATION_ID = jcvSMIE4EKinnyYFPmqm   (your actual location id)
// - CF_ACX_CONSOLE_LOCATION_NAME = <custom field id>
// - CF_ACX_CONSOLE_FAIL_STREAK   = <custom field id>
// - CF_ACX_CONSOLE_LAST_REASON   = <custom field id>
// - CF_ACX_STARTED_AT_STR        = <custom field id>
//
// Notes:
// - We do NOT use email search (too many edge cases). We require contact_id.
// - We do NOT include locationId/id in the PUT body (your 422 proved it’s forbidden on this endpoint).
//

export async function handler(event) {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  });

  try {
    // 0) Method gate
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    // 1) Env
    const GHL_API_KEY = process.env.GHL_API_KEY; // PIT token
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

    const CF_ACX_CONSOLE_LOCATION_NAME = process.env.CF_ACX_CONSOLE_LOCATION_NAME;
    const CF_ACX_CONSOLE_FAIL_STREAK = process.env.CF_ACX_CONSOLE_FAIL_STREAK;
    const CF_ACX_CONSOLE_LAST_REASON = process.env.CF_ACX_CONSOLE_LAST_REASON;
    const CF_ACX_STARTED_AT_STR = process.env.CF_ACX_STARTED_AT_STR;

    const missingEnv = [];
    if (!GHL_API_KEY) missingEnv.push("GHL_API_KEY");
    if (!GHL_LOCATION_ID) missingEnv.push("GHL_LOCATION_ID");

    const missingCF = [];
    if (!CF_ACX_CONSOLE_LOCATION_NAME) missingCF.push("CF_ACX_CONSOLE_LOCATION_NAME");
    if (!CF_ACX_CONSOLE_FAIL_STREAK) missingCF.push("CF_ACX_CONSOLE_FAIL_STREAK");
    if (!CF_ACX_CONSOLE_LAST_REASON) missingCF.push("CF_ACX_CONSOLE_LAST_REASON");
    if (!CF_ACX_STARTED_AT_STR) missingCF.push("CF_ACX_STARTED_AT_STR");

    if (missingEnv.length) {
      return json(500, { ok: false, error: "missing_env", missing: missingEnv });
    }
    if (missingCF.length) {
      return json(500, { ok: false, error: "missing_custom_field_ids", missing: missingCF });
    }

    // 2) Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }

    // 3) Required identifier
    const contactId =
      body.contact_id ||
      body.contactId ||
      body.ghl_contact_id ||
      null;

    if (!contactId) {
      return json(400, { ok: false, error: "missing_contact_id" });
    }

    // 4) Validate fail streak must be NUMBER
    const failStreakNum = Number(body.acx_console_fail_streak);
    if (!Number.isFinite(failStreakNum)) {
      return json(400, {
        ok: false,
        error: "invalid_fail_streak_number",
        received: body.acx_console_fail_streak,
      });
    }

    // 5) Build payload (custom fields)
    const customFields = [
      { id: CF_ACX_CONSOLE_LOCATION_NAME, value: String(body.acx_console_location_name || "") },
      { id: CF_ACX_CONSOLE_FAIL_STREAK, value: failStreakNum }, // NUMBER ONLY
      { id: CF_ACX_CONSOLE_LAST_REASON, value: String(body.acx_console_last_reason || "") },
      { id: CF_ACX_STARTED_AT_STR, value: String(body.acx_started_at_str || "") },
    ];

    // 6) HTTP headers
    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const BASE = "https://services.leadconnectorhq.com";

    // 7) PROVE contact exists + token has access
    const getUrl = `${BASE}/contacts/${encodeURIComponent(contactId)}`;
    const getRes = await fetch(getUrl, { method: "GET", headers });
    const getText = await getRes.text();

    if (!getRes.ok) {
      return json(404, {
        ok: false,
        error: "contact_not_found_by_id",
        locationId: GHL_LOCATION_ID,
        contactId,
        upstream: { url: getUrl, status: getRes.status, body: safeParse(getText) ?? getText },
      });
    }

    // Optional: enforce correct location by checking contact payload (if returned)
    const getJson = safeParse(getText);
    const contactLocationId =
      getJson?.contact?.locationId ||
      getJson?.locationId ||
      getJson?.contact?.location_id ||
      null;

    // If GHL returns locationId and it doesn't match env, hard-fail (prevents writing to wrong location context)
    if (contactLocationId && String(contactLocationId) !== String(GHL_LOCATION_ID)) {
      return json(409, {
        ok: false,
        error: "location_mismatch",
        expectedLocationId: GHL_LOCATION_ID,
        contactLocationId,
        contactId,
      });
    }

    // 8) UPDATE (NO locationId/id in body)
    const putUrl = `${BASE}/contacts/${encodeURIComponent(contactId)}`;
    const updatePayload = { customFields };

    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(updatePayload),
    });

    const putText = await putRes.text();
    const putJson = safeParse(putText);

    if (!putRes.ok) {
      return json(502, {
        ok: false,
        error: "update_failed",
        locationId: GHL_LOCATION_ID,
        contactId,
        outbound: {
          // show the exact ids we attempted (proves they are not undefined)
          customFieldIds: customFields.map((f) => f.id),
        },
        upstream: { url: putUrl, status: putRes.status, body: putJson ?? putText },
      });
    }

    // 9) SUCCESS — only after GET + PUT succeeded
    return json(200, {
      ok: true,
      locationId: GHL_LOCATION_ID,
      contactId,
      failStreak: failStreakNum,
      cf_ids_present: {
        loc: true,
        streak: true,
        reason: true,
        started: true,
      },
      // tiny proof payload to show GHL returned something (optional)
      update_response_has_json: putJson ? true : false,
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: "internal_error",
      message: String(err),
    });
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
