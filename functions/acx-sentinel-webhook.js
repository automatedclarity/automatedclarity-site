// netlify/functions/acx-sentinel-webhook.js

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }

    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

    if (!GHL_API_KEY || !GHL_LOCATION_ID) {
      console.log("[SENTINEL] missing env", {
        hasKey: !!GHL_API_KEY,
        hasLocation: !!GHL_LOCATION_ID,
      });
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "missing_env" }),
      };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "invalid_json" }),
      };
    }

    console.log("[SENTINEL] inbound.body", body);
    console.log("[SENTINEL] locationId", GHL_LOCATION_ID);

    const email = body.email || body.lead_email || null;

    if (!email && !body.contact_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "missing_contact_identifier" }),
      };
    }

    const failStreakNum = Number(body.acx_console_fail_streak);

    if (!Number.isFinite(failStreakNum)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "invalid_fail_streak_number" }),
      };
    }

    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    let contactId = body.contact_id || null;

    // ----- SEARCH CONTACT IF EMAIL PROVIDED -----
    if (!contactId && email) {
      console.log("[SENTINEL] searching email", email);

      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            locationId: GHL_LOCATION_ID,
            query: email,
          }),
        }
      );

      const searchText = await searchRes.text();
      console.log("[SENTINEL] ghl.search.status", searchRes.status);
      console.log("[SENTINEL] ghl.search.body.raw", searchText);

      if (!searchRes.ok) {
        return {
          statusCode: 500,
          body: JSON.stringify({ ok: false, error: "search_failed" }),
        };
      }

      const searchJson = JSON.parse(searchText);
      const contacts = searchJson.contacts || [];

      if (!contacts.length) {
        return {
          statusCode: 404,
          body: JSON.stringify({ ok: false, error: "contact_not_found" }),
        };
      }

      contactId = contacts[0].id;
    }

    // ----- UPDATE CONTACT -----
    const updatePayload = {
      locationId: GHL_LOCATION_ID,
      id: contactId,
      customFields: [
        {
          id: process.env.CF_ACX_CONSOLE_LOCATION_NAME,
          value: body.acx_console_location_name,
        },
        {
          id: process.env.CF_ACX_CONSOLE_FAIL_STREAK,
          value: failStreakNum,
        },
        {
          id: process.env.CF_ACX_CONSOLE_LAST_REASON,
          value: body.acx_console_last_reason,
        },
        {
          id: process.env.CF_ACX_STARTED_AT_STR,
          value: body.acx_started_at_str,
        },
      ],
    };

    console.log("[SENTINEL] outbound.payload", updatePayload);

    const updateRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(updatePayload),
      }
    );

    const updateText = await updateRes.text();

    console.log("[SENTINEL] ghl.update.status", updateRes.status);
    console.log("[SENTINEL] ghl.update.body", updateText);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        contactId,
        failStreak: failStreakNum,
      }),
    };
  } catch (err) {
    console.log("[SENTINEL] fatal", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "internal_error" }),
    };
  }
}
