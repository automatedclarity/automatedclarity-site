// netlify/functions/acx-sentinel-watchdog.js
// ACX Sentinel — Signal Watchdog (5-min loop)
// + Blob event logging
// + dedicated Sentinel token only
// + correct GHL contacts request shape

const { getStore } = require("@netlify/blobs");

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";
const DEFAULT_SENTINEL_URL =
  "https://console.automatedclarity.com/.netlify/functions/acx-sentinel-webhook";

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

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
  const json = parsed.ok ? parsed.value : null;

  if (!res.ok) {
    const err = new Error(`Sentinel webhook failed: ${res.status}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

async function appendSentinelEvent(event) {
  const store = getStore("acx-sentinel");
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const key = `sentinel/${yyyy}-${mm}-${dd}/events.ndjson`;

  const line = JSON.stringify(event) + "\n";
  const existing = (await store.get(key, { type: "text" })) || "";
  await store.set(key, existing + line);
}

function buildRunId(contactId) {
  return `watchdog-${Date.now()}-${contactId}`;
}

exports.handler = async () => {
  try {
    const locationId = getEnv("GHL_LOCATION_ID", true);

    const data = await ghlRequest(
      `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=100`
    );

    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    const nowMs = Date.now();

    for (const c of contacts) {
      try {
        const contactId = c?.id;
        if (!contactId) continue;

        const lastEventAt = getFieldValue(c, "acx_last_event_at");
        const maxGapMinutes = coerceNumber(
          getFieldValue(c, "acx_signal_expected_max_gap_minutes"),
          30
        );
        const currentFailStreak = coerceNumber(
          getFieldValue(c, "acx_fail_streak"),
          0
        );
        const grantStatus =
          getFieldValue(c, "acx_grant_status") || "unknown";

        const runId = buildRunId(contactId);

        let fail = false;
        let reason = "within_gap";

        if (!lastEventAt) {
          fail = true;
          reason = "missing_last_event";
        } else {
          const lastMs = new Date(lastEventAt).getTime();

          if (Number.isNaN(lastMs)) {
            fail = true;
            reason = "invalid_last_event";
          } else {
            const diffMinutes = (nowMs - lastMs) / 60000;
            if (diffMinutes > maxGapMinutes) {
              fail = true;
              reason = "gap_exceeded";
            }
          }
        }

        if (fail) {
          const nextFailStreak = currentFailStreak + 1;

          await appendSentinelEvent({
            ts: isoNow(),
            run_id: runId,
            contact_id: contactId,
            location_id: locationId,
            event_type: "signal_stale",
            status: "critical",
            reason,
            fail_streak: nextFailStreak,
            grant_status: grantStatus,
            last_event_at: lastEventAt || null,
            max_gap_minutes: maxGapMinutes,
          });

          await postSentinel({
            contact_id: contactId,
            location_id: locationId,
            run_id: runId,
            status: "critical",
            fail_streak: nextFailStreak,
            grant_status: grantStatus,
            last_event_at: lastEventAt || null,
            reason,
          });
        } else {
          await appendSentinelEvent({
            ts: isoNow(),
            run_id: runId,
            contact_id: contactId,
            location_id: locationId,
            event_type: "signal_ok",
            status: "optimal",
            reason,
            fail_streak: 0,
            grant_status: grantStatus,
            last_event_at: lastEventAt || null,
            max_gap_minutes: maxGapMinutes,
          });

          await postSentinel({
            contact_id: contactId,
            location_id: locationId,
            run_id: runId,
            status: "optimal",
            fail_streak: 0,
            grant_status: grantStatus,
            last_event_at: lastEventAt || null,
            reason,
          });
        }
      } catch (innerErr) {
        console.error("WATCHDOG_CONTACT_ERROR", {
          error: innerErr?.message || String(innerErr),
          details: innerErr?.details || null,
          status: innerErr?.status || null,
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        checked: contacts.length,
      }),
    };
  } catch (err) {
    console.error("WATCHDOG_FATAL", {
      error: err?.message || String(err),
      details: err?.details || null,
      status: err?.status || null,
    });

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err?.message || "unknown_error",
      }),
    };
  }
};
