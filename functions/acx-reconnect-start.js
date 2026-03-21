// netlify/functions/acx-reconnect-start.js
// Starts a reconnect flow for a specific inbox inside a Sentinel incident.
// Validates incident + token from query params, then redirects to the next step.
//
// Current locked behavior:
// - accepts: incident, token, inbox
// - validates against Netlify Blobs
// - verifies incident token
// - verifies inbox belongs to incident
// - redirects to reconnect page placeholder if valid
//
// Note:
// This does NOT launch Nylas OAuth yet unless you wire that URL below.
// For now it proves the per-inbox flow and removes the missing_params failure.

const { getStore } = require("@netlify/blobs");

const BLOBS_STORE_NAME = process.env.ACX_BLOBS_STORE || "acx-sentinel";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const qs = event.queryStringParameters || {};
    const incidentId = firstNonEmpty(qs.incident);
    const token = firstNonEmpty(qs.token);
    const inbox = firstNonEmpty(qs.inbox);

    if (!incidentId || !token || !inbox) {
      return json(400, { ok: false, error: "missing_params" });
    }

    const store = getStoreManual();
    const key = `sentinel/incidents/${incidentId}.json`;
    const raw = await store.get(key, { type: "text" });

    if (!raw) {
      return json(404, { ok: false, error: "incident_not_found" });
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return json(500, { ok: false, error: "incident_parse_failed" });
    }

    if (!record || record.incident_id !== incidentId) {
      return json(404, { ok: false, error: "incident_not_found" });
    }

    if (String(record.token || "") !== token) {
      return json(403, { ok: false, error: "invalid_token" });
    }

    if (isExpired(record.expires_at)) {
      return json(410, { ok: false, error: "incident_expired" });
    }

    const inboxes = Array.isArray(record.inboxes) ? record.inboxes : [];
    const normalizedInbox = normalizeEmail(inbox);

    const matchedInbox = inboxes.find((item) => {
      const itemKey = normalizeEmail(item.key || "");
      const itemEmail = normalizeEmail(item.email || "");
      return normalizedInbox === itemKey || normalizedInbox === itemEmail;
    });

    if (!matchedInbox) {
      return json(404, { ok: false, error: "inbox_not_found" });
    }

    // Placeholder next step:
    // Replace this with your real Nylas reconnect/OAuth URL builder later.
    //
    // For now, redirect back to reconnect page with a success-style marker so the
    // flow proves end-to-end and confirms the selected inbox is valid.

    const reconnectBase = firstNonEmpty(process.env.ACX_RECONNECT_URL);
    if (!reconnectBase) {
      return json(500, { ok: false, error: "missing_reconnect_url" });
    }

    const url = new URL(reconnectBase);
    url.searchParams.set("incident", incidentId);
    url.searchParams.set("token", token);
    url.searchParams.set("inbox", normalizedInbox);
    url.searchParams.set("start", "ok");

    return redirect(url.toString());
  } catch (err) {
    console.error("ACX_RECONNECT_START_ERROR", {
      message: err?.message,
      stack: err?.stack,
    });

    return json(500, {
      ok: false,
      error: err?.message || "internal_error",
    });
  }
};
