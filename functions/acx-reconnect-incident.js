// netlify/functions/acx-reconnect-incident.js
// Returns a single incident record for the reconnect page

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (_) {
  getStore = null;
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

function getBlobStore() {
  if (!getStore) throw new Error("Netlify Blobs is not available");
  return getStore({
    name: "acx-sentinel",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

exports.handler = async (event) => {
  try {
    const incidentId =
      event.queryStringParameters?.i ||
      "";

    if (!incidentId) {
      return json(400, { ok: false, error: "missing_incident_id" });
    }

    const store = getBlobStore();
    const key = `reconnect/incidents/${incidentId}.json`;
    const incident = await store.get(key, { type: "json" });

    if (!incident) {
      return json(404, { ok: false, error: "incident_not_found" });
    }

    if (incident.resolved) {
      return json(200, {
        ok: true,
        resolved: true,
        incident_id: incidentId,
        company_name: incident.company_name || "your system",
        connections: incident.connections || [],
      });
    }

    if (incident.expires_at && Date.now() > new Date(incident.expires_at).getTime()) {
      return json(410, { ok: false, error: "incident_expired" });
    }

    return json(200, {
      ok: true,
      incident_id: incidentId,
      company_name: incident.company_name || "your system",
      issued_at: incident.issued_at || null,
      expires_at: incident.expires_at || null,
      connections: incident.connections || [],
      resolved: false,
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err?.message || "unknown_error",
    });
  }
};
