// netlify/functions/acx-reconnect-start.js
// Validates incident + selected connection and redirects to the actual auth start

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (_) {
  getStore = null;
}

function getBlobStore() {
  if (!getStore) throw new Error("Netlify Blobs is not available");
  return getStore({
    name: "acx-sentinel",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

function redirect(url) {
  return {
    statusCode: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

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

exports.handler = async (event) => {
  try {
    const incidentId = event.queryStringParameters?.i || "";
    const connectionId = event.queryStringParameters?.c || "";

    if (!incidentId || !connectionId) {
      return json(400, { ok: false, error: "missing_params" });
    }

    const store = getBlobStore();
    const key = `reconnect/incidents/${incidentId}.json`;
    const incident = await store.get(key, { type: "json" });

    if (!incident) {
      return json(404, { ok: false, error: "incident_not_found" });
    }

    if (incident.resolved) {
      return json(409, { ok: false, error: "incident_already_resolved" });
    }

    if (incident.expires_at && Date.now() > new Date(incident.expires_at).getTime()) {
      return json(410, { ok: false, error: "incident_expired" });
    }

    const connection = (incident.connections || []).find((c) => String(c.id) === String(connectionId));
    if (!connection) {
      return json(404, { ok: false, error: "connection_not_found" });
    }

    const authBase = (process.env.ACX_RECONNECT_AUTH_URL || "").trim();
    if (!authBase) {
      return json(500, { ok: false, error: "missing_auth_url" });
    }

    const url = new URL(authBase);
    url.searchParams.set("incident", incidentId);
    url.searchParams.set("cid", incident.contact_id || "");
    url.searchParams.set("connection_id", connection.id || "");
    url.searchParams.set("email", connection.email || "");

    return redirect(url.toString());
  } catch (err) {
    return json(500, {
      ok: false,
      error: err?.message || "unknown_error",
    });
  }
};
