// netlify/functions/acx-reconnect-incident.js
// Reads a Sentinel reconnect incident from Netlify Blobs
// Validates incident + token from query params
// Returns only the data needed by reconnect.html

const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const BLOBS_STORE_NAME = process.env.ACX_BLOBS_STORE || "acx-sentinel";

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function maskEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return "";
  const [local, domain] = clean.split("@");
  if (!local || !domain) return clean;
  if (local.length <= 2) return `${local[0] || "*"}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function getStoreManual() {
  const siteID = firstNonEmpty(process.env.NETLIFY_SITE_ID);
  const token = firstNonEmpty(process.env.NETLIFY_BLOBS_TOKEN);

  if (!siteID) throw new Error("Missing env var: NETLIFY_SITE_ID");
  if (!token) throw new Error("Missing env var: NETLIFY_BLOBS_TOKEN");

  return getStore({
    name: BLOBS_STORE_NAME,
    siteID,
    token,
  });
}

function isExpired(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() > t;
}

function buildInboxResponse(record, requestedInbox) {
  const inboxes = Array.isArray(record.inboxes) ? record.inboxes : [];

  return inboxes.map((inbox, index) => {
    const email = inbox.email || inbox.key || "";
    const key = inbox.key || email || `inbox_${index + 1}`;
    const status = String(inbox.status || "disconnected").toLowerCase();
    const selected =
      requestedInbox &&
      (requestedInbox === key || requestedInbox === email);

    return {
      key,
      label: inbox.label || `Inbox ${index + 1}`,
      email_masked: maskEmail(email),
      email_raw: email,
      status,
      selected: Boolean(selected),
      reconnect_required: status !== "connected",
      grant_id: inbox.grant_id || "",
      reconnected_at: inbox.reconnected_at || "",
    };
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const qs = event.queryStringParameters || {};
    const incidentId = firstNonEmpty(qs.incident);
    const token = firstNonEmpty(qs.token);
    const requestedInbox = firstNonEmpty(qs.inbox);

    if (!incidentId || !token) {
      return json(400, {
        ok: false,
        error: "missing_incident_or_token",
      });
    }

    const store = getStoreManual();
    const key = `sentinel/incidents/${incidentId}.json`;
    const raw = await store.get(key, { type: "text" });

    if (!raw) {
      return json(404, {
        ok: false,
        error: "incident_not_found",
      });
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return json(500, {
        ok: false,
        error: "incident_parse_failed",
      });
    }

    if (!record || record.incident_id !== incidentId) {
      return json(404, {
        ok: false,
        error: "incident_not_found",
      });
    }

    if (String(record.token || "") !== token) {
      return json(403, {
        ok: false,
        error: "invalid_token",
      });
    }

    if (isExpired(record.expires_at)) {
      return json(410, {
        ok: false,
        error: "incident_expired",
      });
    }

    const inboxes = buildInboxResponse(record, requestedInbox);

    return json(200, {
      ok: true,
      incident: {
        incident_id: record.incident_id,
        contact_name: record.contact_name || "",
        company_name: record.company_name || "",
        sentinel_status: record.sentinel_status || "critical",
        grant_status: record.grant_status || "disconnected",
        created_at: record.created_at || "",
        expires_at: record.expires_at || "",
        requested_inbox: requestedInbox || "",
        inboxes,
      },
    });
  } catch (err) {
    console.error("ACX_RECONNECT_INCIDENT_ERROR", {
      message: err?.message,
      stack: err?.stack,
    });

    return json(500, {
      ok: false,
      error: err?.message || "internal_error",
    });
  }
};
