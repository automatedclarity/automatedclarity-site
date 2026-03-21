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

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const qs = event.queryStringParameters || {};
    const incidentId = firstNonEmpty(qs.incident);
    const token = firstNonEmpty(qs.token);
    const inbox = normalizeEmail(firstNonEmpty(qs.inbox));
    const grantId = firstNonEmpty(qs.grant_id);
    const connectedEmail = normalizeEmail(firstNonEmpty(qs.email));
    const provider = firstNonEmpty(qs.provider);

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

    const nowIso = new Date().toISOString();
    const inboxes = Array.isArray(record.inboxes) ? record.inboxes : [];
    let updated = false;

    const nextInboxes = inboxes.map((item) => {
      const itemKey = normalizeEmail(item.key || "");
      const itemEmail = normalizeEmail(item.email || "");
      const matched = inbox === itemKey || inbox === itemEmail;

      if (!matched) return item;

      updated = true;

      return {
        ...item,
        key: item.key || inbox,
        email: connectedEmail || item.email || inbox,
        status: "connected",
        grant_id: grantId || item.grant_id || "",
        provider: provider || item.provider || "",
        reconnected_at: item.reconnected_at || nowIso,
      };
    });

    if (!updated) {
      return json(404, { ok: false, error: "inbox_not_found" });
    }

    const remaining = nextInboxes.filter(
      (item) => String(item.status || "").toLowerCase() !== "connected"
    );

    const allConnected = remaining.length === 0;

    const nextRecord = {
      ...record,
      inboxes: nextInboxes,
      status: allConnected ? "completed" : "open",
      repaired_at: allConnected
        ? (record.repaired_at || nowIso)
        : (record.repaired_at || ""),
      updated_at: nowIso,
    };

    await store.set(key, JSON.stringify(nextRecord), {
      metadata: {
        type: "sentinel_reconnect_incident",
        incident_id: nextRecord.incident_id || "",
        contact_id: nextRecord.contact_id || "",
        location_id: nextRecord.location_id || "",
        notify_email: nextRecord.notify_email || "",
        status: nextRecord.status || "open",
      },
    });

    const reconnectBase = firstNonEmpty(process.env.ACX_RECONNECT_URL);
    if (!reconnectBase) {
      return json(500, { ok: false, error: "missing_acx_reconnect_url" });
    }

    const reconnectUrl = new URL(reconnectBase);
    reconnectUrl.searchParams.set("incident", incidentId);
    reconnectUrl.searchParams.set("token", token);

    const completionUrl = new URL(reconnectBase);
    completionUrl.searchParams.set("incident", incidentId);
    completionUrl.searchParams.set("token", token);
    completionUrl.searchParams.set("done", "1");

    if (!allConnected) {
      reconnectUrl.searchParams.set("inbox", inbox);
      reconnectUrl.searchParams.set("reconnected", "ok");
      return redirect(reconnectUrl.toString());
    }

    return redirect(completionUrl.toString());
  } catch (err) {
    console.error("ACX_RECONNECT_COMPLETE_ERROR", {
      message: err?.message,
      stack: err?.stack,
    });

    return json(500, {
      ok: false,
      error: err?.message || "internal_error",
    });
  }
};
