// netlify/functions/acx-sentinel-webhook.js
// ACX Sentinel — Contact Writeback (Production Safe)
// - Resolves custom field IDs at runtime (no manual IDs)
// - Writes deterministically
// - Verifies read-after-write
// - Adds operator-friendly local time field: acx_started_at_local

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

const FIELD_SPECS = [
  { key: "acx_started_at_str", aliases: ["acx_started_at_str", "acx started at str", "acx started at"] },
  { key: "acx_started_at_local", aliases: ["acx_started_at_local", "acx started at local", "detected local"] },
  { key: "acx_console_fail_streak", aliases: ["acx_console_fail_streak", "acx console fail streak", "fail streak"] },
];

const cache = { customFields: new Map() };

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeJsonParse(raw) {
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (e) { return { ok: false, error: e }; }
}

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function buildHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: getEnv("GHL_API_VERSION") || DEFAULT_API_VERSION,
  };
}

async function httpJson(method, url, headers, bodyObj) {
  const init = { method, headers };
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj);

  const res = await fetch(url, init);
  const text = await res.text();
  const parsed = safeJsonParse(text);
  const json = parsed.ok ? parsed.value : null;

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} calling ${url}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }
  return json ?? {};
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
  }
  return undefined;
}

function coerceInt(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toStartedAtISO(payload) {
  const direct = pickFirst(payload, ["acx_started_at_str"]);
  if (direct !== undefined) return String(direct);

  const raw = pickFirst(payload, ["acx_started_at", "started_at", "acx_started_at_ms", "started_at_ms"]);
  if (raw === undefined) return new Date().toISOString();

  if (typeof raw === "number" || /^[0-9]+$/.test(String(raw).trim())) {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      const ms = num < 2_000_000_000 ? num * 1000 : num;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  const d2 = new Date(String(raw));
  if (!Number.isNaN(d2.getTime())) return d2.toISOString();

  return new Date().toISOString();
}

function toLocalTimeString(isoString) {
  const tz = process.env.ACX_TZ || "America/Vancouver";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return String(isoString);
  return d.toLocaleString("en-CA", { timeZone: tz });
}

async function getCustomFieldsForLocation({ apiBase, locationId, token }) {
  const cached = cache.customFields.get(locationId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const headers = buildHeaders(token);
  const url = `${apiBase}/locations/${encodeURIComponent(locationId)}/customFields`;
  const data = await httpJson("GET", url, headers);

  const list =
    (Array.isArray(data?.customFields) && data.customFields) ||
    (Array.isArray(data?.fields) && data.fields) ||
    (Array.isArray(data?.data) && data.data) ||
    (Array.isArray(data) && data) ||
    [];

  const fieldsByNormalized = new Map();

  for (const f of list) {
    const id = f?.id || f?._id || f?.fieldId;
    if (!id) continue;

    const name = f?.name || f?.fieldName || "";
    const key = f?.fieldKey || f?.key || f?.slug || "";

    const nName = normalizeKey(name);
    const nKey = normalizeKey(key);

    if (nName) fieldsByNormalized.set(nName, f);
    if (nKey) fieldsByNormalized.set(nKey, f);
  }

  const entry = {
    expiresAt: Date.now() + 15 * 60 * 1000,
    fieldsByNormalized,
    rawCount: list.length,
  };

  cache.customFields.set(locationId, entry);
  return entry;
}

function resolveFieldIds(cfCache) {
  const resolved = {};
  const missing = [];

  for (const spec of FIELD_SPECS) {
    const candidates = [spec.key, ...(spec.aliases || [])].map(normalizeKey);
    let fieldObj = null;

    for (const c of candidates) {
      const found = cfCache.fieldsByNormalized.get(c);
      if (found) { fieldObj = found; break; }
    }

    const id = fieldObj?.id || fieldObj?._id || fieldObj?.fieldId;
    if (!id) { missing.push(spec.key); continue; }

    resolved[spec.key] = String(id);
  }

  if (missing.length) {
    const err = new Error(
      `Missing required custom fields in this subaccount: ${missing.join(", ")}. Create them, then retry.`
    );
    err.code = "MISSING_CUSTOM_FIELDS";
    throw err;
  }

  return resolved;
}

async function updateContactCustomFields({ apiBase, contactId, token, customFieldsPayload }) {
  const headers = buildHeaders(token);
  const url = `${apiBase}/contacts/${encodeURIComponent(contactId)}`;
  return await httpJson("PUT", url, headers, { customFields: customFieldsPayload });
}

async function getContact({ apiBase, contactId, token }) {
  const headers = buildHeaders(token);
  const url = `${apiBase}/contacts/${encodeURIComponent(contactId)}`;
  return await httpJson("GET", url, headers);
}

function extractContactCustomFieldValue(contactObj, fieldId) {
  const idStr = String(fieldId);
  const c = contactObj?.contact || contactObj;

  const arr1 = Array.isArray(c?.customFields) ? c.customFields : null;
  if (arr1) {
    const hit = arr1.find((x) => x && String(x.id || x.fieldId) === idStr);
    if (hit) return hit.field_value ?? hit.value ?? null;
  }

  const arr2 = Array.isArray(c?.additionalFields?.customFields?.values)
    ? c.additionalFields.customFields.values
    : null;
  if (arr2) {
    const hit = arr2.find((x) => x && String(x.fieldId || x.id) === idStr);
    if (hit) return hit.value ?? hit.field_value ?? null;
  }

  return null;
}

exports.handler = async (event) => {
  try {
    const apiBase = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
    const defaultLocationId = getEnv("GHL_LOCATION_ID") || "";
    const token = getEnv("GHL_LOCATION_TOKEN", true);

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";

    const parsed = safeJsonParse(rawBody);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
    }

    const payload = parsed.value;

    const contactId = pickFirst(payload, ["contact_id", "contactId", "id"]);
    if (!contactId) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing contact_id" }) };

    const locationId = pickFirst(payload, ["location_id", "locationId"]) || defaultLocationId;
    if (!locationId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing locationId" }) };
    }

    // Resolve field IDs
    const cfCache = await getCustomFieldsForLocation({ apiBase, locationId, token });
    const fieldIds = resolveFieldIds(cfCache);

    // Deterministic values
    const startedISO = toStartedAtISO(payload);
    const startedLocal = toLocalTimeString(startedISO);

    const failStreak = coerceInt(
      pickFirst(payload, ["acx_console_fail_streak", "fail_streak", "failStreak"]),
      0
    );

    const customFieldsPayload = [
      { id: fieldIds.acx_started_at_str, field_value: startedISO },
      { id: fieldIds.acx_started_at_local, field_value: startedLocal },
      { id: fieldIds.acx_console_fail_streak, field_value: String(failStreak) },
    ];

    await updateContactCustomFields({ apiBase, contactId, token, customFieldsPayload });

    const contactAfter = await getContact({ apiBase, contactId, token });

    const verified = {
      acx_started_at_str: extractContactCustomFieldValue(contactAfter, fieldIds.acx_started_at_str),
      acx_started_at_local: extractContactCustomFieldValue(contactAfter, fieldIds.acx_started_at_local),
      acx_console_fail_streak: extractContactCustomFieldValue(contactAfter, fieldIds.acx_console_fail_streak),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        locationId,
        contactId,
        resolvedFieldIds: fieldIds,
        written: {
          acx_started_at_str: startedISO,
          acx_started_at_local: startedLocal,
          acx_console_fail_streak: failStreak,
        },
        verified,
        customFieldCatalogSize: cfCache.rawCount,
      }),
    };
  } catch (err) {
    const statusCode = err?.status && Number.isFinite(err.status) ? err.status : 500;
    return {
      statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err?.message || "Unknown error",
        code: err?.code,
        details: err?.details,
      }),
    };
  }
};
