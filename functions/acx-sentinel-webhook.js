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

// Always returns a STRING safe for email/SMS templates
const formatStartedAt = (d = new Date()) => {
  // "Feb 11, 2026 1:05 AM"
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
  } catch {
    body = {};
  }

  const contactId =
    pick(body, ["contact_id", "contactId"]) ||
    pick(body?.contact, ["id", "contact_id"]);

  if (!contactId) {
    return json(400, {
      ok: false,
      error: "Missing contact_id in payload",
      received: body,
    });
  }

  const apiKey = process.env.LC_API_KEY;
  if (!apiKey) {
    return json(500, { ok: false, error: "Missing LC_API_KEY env var" });
  }

  // Sentinel payload (console-level identifiers are fine)
  const runId = pick(body, ["run_id", "runId"]);
  const consoleLocationId = pick(body, ["location_id", "locationId", "console_location_id"]);
  const locationName = pick(body, ["location_name", "locationName"]);
  const status = pick(body, ["status", "console_status", "health_status"]);
  const reason = pick(body, ["reason", "last_reason", "fail_reason"]);
  const failStreak = String(pick(body, ["fail_streak", "failStreak", "streak"]) || "");

  const lastOkDate = toDateOnly(new Date());
  const startedAtStr = formatStartedAt(new Date());

  // ---- 1) Read CONTACT to get writable custom field IDs ----
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
      status: readResp.status,
      response: readText,
      contact_id: contactId,
    });
  }

  let contactJson = {};
  try {
    contactJson = JSON.parse(readText);
  } catch {
    contactJson = {};
  }

  const contact = contactJson?.contact || contactJson || {};
  const existingCustom = contact.customFields || contact.customField || [];

  // Map: lowercased fieldKey -> id (case-insensitive)
  const keyToId = new Map();
  for (const f of existingCustom) {
    const rawKey = f.fieldKey || f.key || f.name;
    const id = f.id;
    if (rawKey && id) keyToId.set(String(rawKey).toLowerCase(), id);
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
    setCF("acx_console_last_ok", lastOkDate),
    setCF("acx_started_at_str", startedAtStr),
  ].filter(Boolean);

  // Hard fail if the started-at field is not writable on this contact
  if (!keyToId.get("acx_started_at_str")) {
    return json(422, {
      ok: false,
      error: "acx_started_at_str not found on contact custom fields (no ID to write).",
      fix:
        "In this sub-account: Settings → Custom Fields → ensure acx_started_at_str exists (TEXT). Then open the contact once so it carries the custom field IDs.",
      contact_id: contactId,
      available_keys_sample: Array.from(keyToId.keys()).slice(0, 40),
    });
  }

  // ---- 2) Update contact ----
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
      sent: { customField },
      contact_id: contactId,
    });
  }

  return json(200, {
    ok: true,
    contact_id: contactId,
    wrote_count: customField.length,
    started_at_str_value: startedAtStr,
  });
};
