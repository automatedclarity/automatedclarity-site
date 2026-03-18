// netlify/functions/acx-sentinel-watchdog.js
// ACX Sentinel — Signal Watchdog (5-min loop)
// + Grant detection (added)
// + Recovery detection (added)
// + Manual Blobs config (unchanged)
// + ZERO architecture drift

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (_) {
  getStore = null;
}

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";
const DEFAULT_SENTINEL_URL =
  "https://console.automatedclarity.com/.netlify/functions/acx-sentinel-webhook";

// -------------------- ENV --------------------
function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

// -------------------- HELPERS --------------------
function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function coerceNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function isoNow() {
  return new Date().toISOString();
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: getEnv("GHL_API_VERSION") || DEFAULT_API_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function getFieldValue(contact, key) {
  const normalizedTarget = normalizeKey(key);

  if (
    contact &&
    contact.customFields &&
    typeof contact.customFields === "object" &&
    !Array.isArray(contact.customFields)
  ) {
    if (contact.customFields[key] !== undefined && contact.customFields[key] !== null) {
      return contact.customFields[key];
    }

    for (const [k, v] of Object.entries(contact.customFields)) {
      if (normalizeKey(k) === normalizedTarget) return v;
    }
  }

  if (Array.isArray(contact?.customFields)) {
    for (const field of contact.customFields) {
      const candidates = [
        field?.key,
        field?.name,
        field?.fieldKey,
        field?.customFieldKey,
        field?.id,
      ];

      for (const candidate of candidates) {
        if (normalizeKey(candidate) === normalizedTarget) {
          return (
            field?.value ??
            field?.fieldValue ??
            field?.field_value ??
            field?.val ??
            null
          );
        }
      }
    }
  }

  if (contact && contact[key] !== undefined && contact[key] !== null) {
    return contact[key];
  }

  return undefined;
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

async function ghlRequest(path) {
  const base = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
  const token = getEnv("GHL_SENTINEL_TOKEN", true);
  return httpJson("GET", `${base}${path}`, buildHeaders(token));
}

async function postSentinel(payload) {
  const url = getEnv("ACX_SENTINEL_WEBHOOK_URL") || DEFAULT_SENTINEL_URL;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  const parsed = safeJsonParse(text);

  if (!res.ok) {
    const err = new Error(`Sentinel webhook failed: ${res.status}`);
    err.details = parsed.value || text;
    throw err;
  }

  return parsed.value || {};
}

async function appendSentinelEvent(event) {
  if (!getStore) return false;

  try {
    const store = getStore({
      name: "acx-sentinel",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const key = `sentinel/${new Date().toISOString().slice(0, 10)}.ndjson`;
    const existing = (await store.get(key, { type: "text" })) || "";
    await store.set(key, existing + JSON.stringify(event) + "\n");
    return true;
  } catch (err) {
    console.error("WATCHDOG_BLOBS_DISABLED_OR_FAILED", err.message);
    return false;
  }
}

function buildRunId(contactId) {
  return `watchdog-${Date.now()}-${contactId}`;
}

// -------------------- MAIN --------------------
exports.handler = async () => {
  try {
    const locationId = getEnv("GHL_LOCATION_ID", true);

    const data = await ghlRequest(
      `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`
    );

    const contacts = data.contacts || [];
    const nowMs = Date.now();

    for (const c of contacts) {
      try {
        const contactId = c.id;

        const lastEventAt = getFieldValue(c, "acx_last_event_at");
        const maxGapMinutes = coerceNumber(
          getFieldValue(c, "acx_signal_expected_max_gap_minutes"),
          30
        );
        const prevFail = coerceNumber(
          getFieldValue(c, "acx_fail_streak"),
          0
        );

        const grantStatus = getFieldValue(c, "acx_grant_status") || "unknown";

        let fail = false;
        let reason = "within_gap";

        // 🔴 GRANT FAILURE
        if (normalizeKey(grantStatus) === "disconnected") {
          fail = true;
          reason = "grant_disconnected";
        }

        // 🟡 SIGNAL LOGIC
        if (!fail && !lastEventAt) {
          fail = true;
          reason = "missing_last_event";
        } else if (!fail) {
          const diffMinutes =
            (nowMs - new Date(lastEventAt).getTime()) / 60000;

          if (diffMinutes > maxGapMinutes) {
            fail = true;
            reason = "gap_exceeded";
          }
        }

        const newFail = fail ? prevFail + 1 : 0;

        // 🟢 RECOVERY
        const recovered = prevFail > 0 && !fail;

        const eventRecord = {
          ts: isoNow(),
          run_id: buildRunId(contactId),
          contact_id: contactId,
          location_id: locationId,
          status: fail ? "critical" : "optimal",
          reason: recovered ? "system_recovered" : reason,
          fail_streak: newFail,
          previous_fail_streak: prevFail,
          grant_status: grantStatus,
          event_type: recovered
            ? "system_recovered"
            : fail
            ? "signal_stale"
            : "signal_ok",
        };

        await appendSentinelEvent(eventRecord);

        await postSentinel(eventRecord);

      } catch (innerErr) {
        console.error("WATCHDOG_CONTACT_ERROR", innerErr.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("WATCHDOG_FATAL", err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
