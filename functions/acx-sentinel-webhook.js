// netlify/functions/acx-sentinel-webhook.js
export async function handler(event) {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  });

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

    const CF_LOC = process.env.CF_ACX_CONSOLE_LOCATION_NAME;
    const CF_STREAK = process.env.CF_ACX_CONSOLE_FAIL_STREAK;
    const CF_REASON = process.env.CF_ACX_CONSOLE_LAST_REASON;
    const CF_STARTED = process.env.CF_ACX_STARTED_AT_STR;

    const missing = [];
    if (!GHL_API_KEY) missing.push("GHL_API_KEY");
    if (!GHL_LOCATION_ID) missing.push("GHL_LOCATION_ID");
    if (!CF_LOC) missing.push("CF_ACX_CONSOLE_LOCATION_NAME");
    if (!CF_STREAK) missing.push("CF_ACX_CONSOLE_FAIL_STREAK");
    if (!CF_REASON) missing.push("CF_ACX_CONSOLE_LAST_REASON");
    if (!CF_STARTED) missing.push("CF_ACX_STARTED_AT_STR");

    if (missing.length) {
      return json(500, { ok: false, error: "missing_env", missing });
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { ok: false, error: "invalid_json" }); }

    const contactId = body.contact_id || body.contactId;
    if (!contactId) return json(400, { ok: false, error: "missing_contact_id" });

    const failStreakNum = Number(body.acx_console_fail_streak);
    if (!Number.isFinite(failStreakNum)) {
      return json(400, { ok: false, error: "invalid_fail_streak_number", received: body.acx_console_fail_streak });
    }

    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const BASE = "https://services.leadconnectorhq.com";

    // 1) GET contact to prove it exists + enforce location match
    const getRes = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}`, { method: "GET", headers });
    const getText = await getRes.text();
    const getJson = safeParse(getText);

    if (!getRes.ok) {
      return json(404, { ok: false, error: "contact_not_found_by_id", upstream: { status: getRes.status, body: getJson || getText } });
    }

    const contactLocationId =
      getJson?.contact?.locationId ||
      getJson?.locationId ||
      null;

    if (contactLocationId && String(contactLocationId) !== String(GHL_LOCATION_ID)) {
      return json(409, {
        ok: false,
        error: "location_mismatch",
        expectedLocationId: GHL_LOCATION_ID,
        contactLocationId,
        contactId,
      });
    }

    // 2) PUT update (NO locationId/id in body)
    const customFields = [
      { id: CF_LOC, value: String(body.acx_console_location_name || "") },
      { id: CF_STREAK, value: failStreakNum },
      { id: CF_REASON, value: String(body.acx_console_last_reason || "") },
      { id: CF_STARTED, value: String(body.acx_started_at_str || "") },
    ];

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
        upstream: { status: putRes.status, body: putJson || putText },
        fieldIdsUsed: {
          location_name: CF_LOC,
          fail_streak: CF_STREAK,
          last_reason: CF_REASON,
          started_at_str: CF_STARTED,
        },
      });
    }

    // 3) Return proof of exactly which fields we wrote
    return json(200, {
      ok: true,
      locationId: GHL_LOCATION_ID,
      contactId,
      failStreak: failStreakNum,
      fieldIdsUsed: {
        location_name: CF_LOC,
        fail_streak: CF_STREAK,
        last_reason: CF_REASON,
        started_at_str: CF_STARTED,
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: "internal_error", message: String(err) });
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
