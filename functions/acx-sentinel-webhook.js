// netlify/functions/acx-sentinel-webhook.js
// ACX Sentinel — Contact Writeback (Production Safe)
// + Matrix Integrity POST
// + manual Netlify Blobs config
// + non-blocking Blob logging

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (_) {
  getStore = null;
}

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

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
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return obj[k];
    }
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

async function appendSentinelEvent(event) {
  if (!getStore) return false;

  try {
    const siteID = getEnv("NETLIFY_SITE_ID", true);
    const token = getEnv("NETLIFY_BLOBS_TOKEN", true);

    const store = getStore("acx-sentinel", { siteID, token });
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const key = `sentinel/${yyyy}-${mm}-${dd}/events.ndjson`;

    const line = JSON.stringify(event) + "\n";
    const existing = (await store.get(key, { type: "text" })) || "";
    await store.set(key, existing + line);
    return true;
  } catch (e) {
    console.error("SENTINEL_BLOBS_DISABLED_OR_FAILED", {
      error: e?.message || String(e),
    });
    return false;
  }
}

async function postMatrixIntegrity({ account, location, integrity, run_id }) {
  try {
    const secret = (process.env.ACX_SECRET || "").trim();
    if (!secret) return;

    const url =
      "https://console.automatedclarity.com/.netlify/functions/acx-matrix-ingest-integrity";

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acx-secret": secret,
      },
      body: JSON.stringify({ account, location, integrity, run_id }),
    });
  } catch (e) {
    console.error("MATRIX_INGEST_INTEGRITY_POST_FAILED", {
      error: e?.message || String(e),
    });
  }
}

exports.handler = async (event) => {
  try {
    const defaultLocationId = getEnv("GHL_LOCATION_ID") || "";

    const rawBody = event.body || "";
    const parsed = safeJsonParse(rawBody);
    if (!parsed.ok || !parsed.value) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
      };
    }

    const payload = parsed.value;

    const contactId = pickFirst(payload, ["contact_id"]);
    if (!contactId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing contact_id" }),
      };
    }

    const locationId = pickFirst(payload, ["location_id"]) || defaultLocationId;
    if (!locationId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing locationId" }),
      };
    }

    const startedISO = toStartedAtISO(payload);
    const startedLocal = toLocalTimeString(startedISO);
    const failStreak = coerceInt(pickFirst(payload, ["fail_streak"]), 0);
    const failureEvent = isFailureEvent(payload, failStreak);

    const integrity =
      failStreak >= 3 ? "critical" :
      failStreak > 0 ? "degraded" :
      "optimal";

    const runId =
      pickFirst(payload, ["run_id"]) ||
      `sentinel-${Date.now()}-${contactId}`;

    // Blob logging is optional — never fail webhook for it
    await appendSentinelEvent({
      ts: new Date().toISOString(),
      run_id: runId,
      contact_id: contactId,
      location_id: locationId,
      event_type: failureEvent ? "signal_stale" : "signal_ok",
      status: integrity,
      reason:
        pickFirst(payload, ["reason"]) ||
        (failureEvent ? "sentinel_failure_event" : "sentinel_healthy_event"),
      fail_streak: failStreak,
      grant_status: pickFirst(payload, ["grant_status"]) || "unknown",
      last_event_at: pickFirst(payload, ["last_event_at"]) || null,
      started_at: startedISO,
      started_at_local: startedLocal,
    });

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
    console.error("SENTINEL_WEBHOOK_FATAL", {
      error: err?.message || "Unknown error",
      details: err?.details || null,
      status: err?.status || null,
    });

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
