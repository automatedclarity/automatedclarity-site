import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}

  // ---- REQUIRED INPUTS ----
  const contactId =
    body.contact_id ||
    body.contactId ||
    body.contact?.id ||
    body.contact?.contact_id;

  if (!contactId) {
    return json(400, { ok: false, error: "Missing contact_id in payload", received: body });
  }

  const apiKey = process.env.LC_API_KEY; // set in Netlify env vars
  if (!apiKey) {
    return json(500, { ok: false, error: "Missing LC_API_KEY env var" });
  }

  // ---- NORMALIZE VALUES (safe defaults) ----
  const runId = body.run_id ?? body.runId ?? "";
  const locationId = body.location_id ?? body.locationId ?? "";
  const locationName = body.location_name ?? body.locationName ?? "";
  const status = body.status ?? body.console_status ?? body.health_status ?? "";
  const reason = body.reason ?? body.last_reason ?? body.fail_reason ?? "";
  const failStreakRaw = body.fail_streak ?? body.failStreak ?? body.streak ?? "";
  const failStreak = (failStreakRaw === "" || failStreakRaw === null || failStreakRaw === undefined)
    ? ""
    : String(failStreakRaw);

  const nowIso = new Date().toISOString();

  // ---- CUSTOM FIELDS WE WRITE (MATCH YOUR EXISTING acx_console_* FIELDS) ----
  // This format works on LeadConnector / GHL v2 for many accounts:
  // customFields: [{ key, value }]
  const payload = {
    customFields: [
      { key: "acx_test_run_id", value: String(runId) },
      { key: "acx_console_location_id", value: String(locationId) },
      { key: "acx_console_location_name", value: String(locationName) },
      { key: "acx_console_status", value: String(status) },
      { key: "acx_console_last_reason", value: String(reason) },
      { key: "acx_console_fail_streak", value: String(failStreak) },
      { key: "acx_console_last_ok", value: nowIso },
      { key: "acx_started_at_str", value: nowIso },
    ],
  };

  // ---- UPDATE CONTACT ----
  // LeadConnector endpoint (common in 2025/2026 builds)
  const url = `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    return json(resp.status, {
      ok: false,
      error: "Contact update failed",
      status: resp.status,
      response: text,
      sent: payload,
    });
  }

  return json(200, {
    ok: true,
    message: "ACX Sentinel updated contact fields",
    contact_id: contactId,
    wrote: payload.customFields.map((x) => x.key),
  });
};
