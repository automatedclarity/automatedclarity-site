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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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

function inferLaneFromEmail(email) {
  const local = normalizeEmail(email).split("@")[0] || "";

  if (/\b(quote|quotes|estimate|estimates)\b/i.test(local)) return "quotes";
  if (/\b(billing|invoice|invoices|accounts|payments?)\b/i.test(local)) return "billing";
  if (/\b(review|reviews|feedback)\b/i.test(local)) return "reviews";
  if (/\b(dispatch|schedule|scheduling)\b/i.test(local)) return "dispatch";
  if (/\b(service)\b/i.test(local)) return "service";
  if (/\b(support|help|office)\b/i.test(local)) return "support";

  return "general";
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const qs = event.queryStringParameters || {};
    const incidentId = firstNonEmpty(qs.incident);
    const token = firstNonEmpty(qs.token);
    const inbox = normalizeEmail(firstNonEmpty(qs.inbox));

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
    const matchedInbox = inboxes.find((item) => {
      const itemKey = normalizeEmail(item.key || "");
      const itemEmail = normalizeEmail(item.email || "");
      return inbox === itemKey || inbox === itemEmail;
    });

    if (!matchedInbox) {
      return json(404, { ok: false, error: "inbox_not_found" });
    }

    const notifyAuthStartBase = firstNonEmpty(process.env.ACX_NOTIFY_AUTH_START_URL);
    if (!notifyAuthStartBase) {
      return json(500, { ok: false, error: "missing_notify_auth_start_url" });
    }

    const clientId =
      firstNonEmpty(record.client_id, qs.client_id, process.env.ACX_DEFAULT_CLIENT_ID) ||
      "automatedclarity";

    const lane =
      firstNonEmpty(matchedInbox.lane, record.lane) ||
      inferLaneFromEmail(matchedInbox.email || matchedInbox.key || inbox);

    const url = new URL(notifyAuthStartBase);
    url.searchParams.set("incident", incidentId);
    url.searchParams.set("token", token);
    url.searchParams.set("inbox", inbox);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("lane", lane);

    console.log("ACX_RECONNECT_START_REDIRECT", {
      incident_id: incidentId,
      inbox,
      client_id: clientId,
      lane,
      notify_auth_start: notifyAuthStartBase,
    });

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
