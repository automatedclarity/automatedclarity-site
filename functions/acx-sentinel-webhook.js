// netlify/functions/acx-sentinel-webhook.js
// ACX Sentinel — Contact Writeback (Production Safe)
// + Matrix Event Writer
// + Matrix Integrity POST (authoritative index writer)

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

const FIELD_SPECS = [
  { key: "acx_started_at_str", aliases: ["acx_started_at_str", "acx started at str", "acx started at"] },
  { key: "acx_started_at_local", aliases: ["acx_started_at_local", "acx started at local", "detected local"] },
  { key: "acx_console_fail_streak", aliases: ["acx_console_fail_streak", "acx console fail streak", "fail streak"] },
  { key: "acx_sentinel_status", aliases: ["acx_sentinel_status", "acx sentinel status", "sentinel status"] },
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
  const raw = pickFirst(payload, ["acx_started_at_str", "acx_started_at", "started_at"]);
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toLocalTimeString(isoString) {
  const tz = process.env.ACX_TZ || "America/Vancouver";
  const d = new Date(isoString);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(d);
}

function isFailureEvent(payload, failStreak) {
  if (failStreak > 0) return true;
  const rawStatus = pickFirst(payload, ["status"]);
  const s = normalizeKey(rawStatus);
  const BAD = new Set(["fail", "failed", "warning", "critical", "down", "error", "unhealthy"]);
  return BAD.has(s);
}

// 🔥 NEW — authoritative Matrix ingest
async function postMatrixIntegrity({ account, location, integrity, run_id }) {
  try {
    const secret = (process.env.ACX_WEBHOOK_SECRET || "").trim();
    if (!secret) return;

    const url = "https://console.automatedclarity.com/.netlify/functions/acx-matrix-ingest-integrity";

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acx-secret": secret,
      },
      body: JSON.stringify({ account, location, integrity, run_id }),
    });
  } catch (e) {
    console.error("MATRIX_INGEST_INTEGRITY_POST_FAILED", e);
  }
}

exports.handler = async (event) => {
  try {
    const apiBase = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
    const defaultLocationId = getEnv("GHL_LOCATION_ID") || "";
    const token = getEnv("GHL_LOCATION_TOKEN", true);

    const rawBody = event.body || "";
    const parsed = safeJsonParse(rawBody);
    if (!parsed.ok || !parsed.value) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error:"Invalid JSON body" }) };
    }

    const payload = parsed.value;

    const contactId = pickFirst(payload, ["contact_id"]);
    if (!contactId) return { statusCode: 400, body: JSON.stringify({ ok:false, error:"Missing contact_id" }) };

    const locationId = pickFirst(payload, ["location_id"]) || defaultLocationId;
    if (!locationId) return { statusCode: 400, body: JSON.stringify({ ok:false, error:"Missing locationId" }) };

    const startedISO = toStartedAtISO(payload);
    const startedLocal = toLocalTimeString(startedISO);
    const failStreak = coerceInt(pickFirst(payload, ["fail_streak"]), 0);
    const failureEvent = isFailureEvent(payload, failStreak);

    const integrity =
      failStreak >= 3 ? "critical" :
      failStreak > 0  ? "degraded" :
      "optimal";

    const runId =
      pickFirst(payload, ["run_id"]) ||
      `sentinel-${Date.now()}-${contactId}`;

    // 🔥 authoritative Matrix ingest
    await postMatrixIntegrity({
      account: String(pickFirst(payload, ["account"]) || "ACX"),
      location: String(locationId),
      integrity,
      run_id: runId,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        locationId,
        contactId,
        integrity,
        runId,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err?.message || "Unknown error",
      }),
    };
  }
};
