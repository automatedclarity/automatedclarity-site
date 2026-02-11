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

// Always returns a STRING safe for templates
const formatStartedAt = (d = new Date()) => {
  // Example: "Feb 11, 2026 1:05 AM"
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return `${date} ${time}`;
};

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const contactId =
    pick(body, ["contact_id", "contactId"]) ||
    pick(body?.contact, ["id", "contact_id"]);

  if (!contactId) {
    return json(400, { ok: false, error: "Missing contact_id", received: body });
  }

  const apiKey = process.env.LC_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: "Missing LC_API_KEY env var" });

  // IMPORTANT:
  // In repull workflow you are sending location_id from contact fields.
  // That might be console loc id (loc_...) — keep it, but don't treat it as GHL Location ID.
  const runId = pick(body, ["run_id", "runId"]);
  const consoleLocationId = pick(body, ["location_id", "locationId", "console_location_id"]);
  const locationName = pick(body, ["location_name", "locationName"]);
  const status = pick(body, ["status", "console_status", "health_status"]);
  const reason = pick(body, ["reason", "last_reason", "fail_reason"]);
  const failStreak = String(pick(body, ["fail_streak", "failStreak", "streak"]) || "");

  const startedAtStr = formatStartedAt(new Date());

  // 1) Read contact to get field IDs that are writable
  const readResp = await fetch(`${LC_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: LC_VERSION,
      Accept: "application/json",
    },
  });

  const readText = await readResp.text();
  if (!readResp.ok) {
    return json(readResp.status, {
      ok: false,
      error: "Contact read failed",
      response: readText,
      contact_id: contactId,
    });
  }

  let contactJson = {};
  try { contactJson = JSON.parse(readText); } catch { contactJson = {}; }
  const contact = contactJson?.contact || contactJson || {};

  const existingCustom = contact.customFields || contact.customField || [];

  // Case-insensitive map: fieldKey -> id
  const keyToId = new Map();
  for (const f of existingCustom) {
    const rawKey = f.fieldKey || f.key || f.name;
    if (rawKey && f.id) keyToId.set(String(rawKey).toLowerCase(), f.id);
  }

  const setCF = (fieldKey, value) => {
    const id = keyToId.get(String(fieldKey).toLowerCase());
    if (!id) return null;
    return { id, value: String(value ?? "") };
  };

  const customField = [
    setCF("acx_test_run_id", runId),
    setCF("acx_console_location_id", consoleLocationId),
    setCF("acx_console_location_name", locationName),
    setCF("acx_console_status", status),
    setCF("acx_console_last_reason", reason),
    setCF("acx_console_fail_streak", failStreak),
    setCF("acx_started_at_str", startedAtStr),
  ].filter(Boolean);

  // Hard fail if started-at not writable (prevents silent blanks)
  if (!keyToId.get("acx_started_at_str")) {
    return json(422, {
      ok: false,
      error: "acx_started_at_str not found on contact custom fields (no ID to write)",
      contact_id: contactId,
      available_keys_sample: Array.from(keyToId.keys()).slice(0, 40),
    });
  }

  // 2) Update
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
      response: updateText,
      contact_id: contactId,
      sent: { customField },
    });
  }

  return json(200, {
    ok: true,
    contact_id: contactId,
    wrote_count: customField.length,
    started_at_str: startedAtStr,
  });
};
