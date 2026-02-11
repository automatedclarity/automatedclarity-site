// netlify/functions/acx-sentinel-webhook.js
// ACX Sentinel Ingest Webhook
// - Accepts POST JSON
// - Logs inbound + outbound deterministically
// - Forces acx_console_fail_streak to be a NUMBER
// - Updates a GHL contact by email (or contact_id if provided)

export async function handler(event) {
  try {
    // 1) Method gate (matches your 405 behavior on GET)
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: "Method Not Allowed",
      };
    }

    // 2) Basic request metadata
    console.log("[SENTINEL] hit", {
      method: event.httpMethod,
      path: event.path,
      qs: event.queryStringParameters || null,
      requestId:
        event.headers?.["x-nf-request-id"] ||
        event.headers?.["X-Nf-Request-Id"] ||
        null,
    });

    // 3) Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.log("[SENTINEL] JSON parse error", String(e));
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "invalid_json" }),
      };
    }
    console.log("[SENTINEL] inbound.body", body);

    // 4) REQUIRED ENV
    const GHL_API_KEY = process.env.GHL_API_KEY; // REQUIRED
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID; // REQUIRED (sub-account location)
    const GHL_BASE_URL = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";

    if (!GHL_API_KEY || !GHL_LOCATION_ID) {
      console.log("[SENTINEL] missing env", {
        hasKey: Boolean(GHL_API_KEY),
        hasLoc: Boolean(GHL_LOCATION_ID),
      });
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "missing_env" }),
      };
    }

    // 5) Identify contact
    // Prefer explicit contact_id if you send it, otherwise use email
    const contactId = body.contact_id || body.contactId || null;
    const email =
      body.email ||
      body.lead_email ||
      body.contact_email ||
      body.contactEmail ||
      null;

    if (!contactId && !email) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "missing_contact_identifier" }),
      };
    }

    // 6) Force NUMBER for fail streak (no text fallback, per your requirement)
    const failStreakNum = Number(body.acx_console_fail_streak);
    if (!Number.isFinite(failStreakNum)) {
      console.log("[SENTINEL] invalid fail streak", {
        raw: body.acx_console_fail_streak,
        coerced: failStreakNum,
        type: typeof body.acx_console_fail_streak,
      });
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "invalid_fail_streak_number" }),
      };
    }

    // 7) Build customFields payload (GHL accepts customFields array)
    // NOTE: "id" must be the Custom Field ID in that sub-account.
    // If you are using "key/name" mapping, replace IDs with your actual IDs.
    //
    // MINIMAL: we only set the four fields you care about + status if provided.
    const customFields = [];

    // Helper: push only if value is not null/undefined/empty string (except number)
    const pushField = (id, value) => {
      if (!id) return;
      if (value === null || value === undefined) return;
      if (typeof value === "string" && value.trim() === "") return;
      customFields.push({ id, value });
    };

    // >>> SET YOUR REAL CUSTOM FIELD IDS HERE <<<
    // These MUST be the GHL custom field IDs (not the names).
    const CF = {
      acx_console_location_name: process.env.CF_ACX_CONSOLE_LOCATION_NAME, // text
      acx_console_fail_streak: process.env.CF_ACX_CONSOLE_FAIL_STREAK, // number
      acx_console_last_reason: process.env.CF_ACX_CONSOLE_LAST_REASON, // text
      acx_started_at_str: process.env.CF_ACX_STARTED_AT_STR, // text
      acx_status: process.env.CF_ACX_STATUS, // optional text
    };

    pushField(CF.acx_console_location_name, body.acx_console_location_name);
    pushField(CF.acx_console_fail_streak, failStreakNum); // NUMBER only
    pushField(CF.acx_console_last_reason, body.acx_console_last_reason);
    pushField(CF.acx_started_at_str, body.acx_started_at_str);
    if (body.acx_status) pushField(CF.acx_status, body.acx_status);

    // 8) Build outbound update payload
    // - If contactId is present, update directly
    // - If not, search by email then update
    const headers = {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    console.log("[SENTINEL] computed.fail_streak", {
      raw: body.acx_console_fail_streak,
      coerced: failStreakNum,
      coercedType: typeof failStreakNum,
    });

    // If you want to also stamp last reason / location name into standard fields, do it here.
    const buildUpdatePayload = (id) => {
      const p = {
        locationId: GHL_LOCATION_ID,
        id,
        customFields,
      };
      // Optional standard fields if present:
      if (email) p.email = email;
      return p;
    };

    const updateContactById = async (id) => {
      const payload = buildUpdatePayload(id);
      console.log("[SENTINEL] outbound.payload", payload);

      const url = `${GHL_BASE_URL}/contacts/${encodeURIComponent(id)}`;
      const res = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      console.log("[SENTINEL] ghl.update.status", res.status);
      console.log("[SENTINEL] ghl.update.body", text);

      return { status: res.status, bodyText: text };
    };

    const findContactByEmail = async (emailAddress) => {
      // Search endpoint varies; this works in many LeadConnectorHQ setups:
      // GET /contacts/?locationId=...&query=...
      const url =
        `${GHL_BASE_URL}/contacts/?locationId=${encodeURIComponent(GHL_LOCATION_ID)}` +
        `&query=${encodeURIComponent(emailAddress)}`;

      const res = await fetch(url, { method: "GET", headers });
      const text = await res.text();

      console.log("[SENTINEL] ghl.search.status", res.status);
      console.log("[SENTINEL] ghl.search.body", text);

      if (!res.ok) return null;

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return null;
      }

      const list = data?.contacts || data?.data?.contacts || [];
      if (!Array.isArray(list) || list.length === 0) return null;

      // Best match: exact email (case-insensitive)
      const lower = String(emailAddress).toLowerCase();
      const exact = list.find((c) => String(c.email || "").toLowerCase() === lower);
      return exact?.id || list[0]?.id || null;
    };

    let finalContactId = contactId;

    if (!finalContactId) {
      finalContactId = await findContactByEmail(email);
      if (!finalContactId) {
        return {
          statusCode: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ ok: false, error: "contact_not_found" }),
        };
      }
    }

    const updateResult = await updateContactById(finalContactId);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        contactId: finalContactId,
        failStreak: failStreakNum,
        ghlStatus: updateResult.status,
      }),
    };
  } catch (err) {
    console.log("[SENTINEL] fatal", String(err), err?.stack || "");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: "internal_error" }),
    };
  }
}
