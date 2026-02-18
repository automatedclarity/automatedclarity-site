// netlify/functions/acx-matrix-webhook.js
// ACX Matrix — Event Writer that matches acx-matrix-summary reader
// - Auth: accepts EITHER x-acx-secret OR Authorization: Bearer
// - Writes Netlify Blobs events into ACX_BLOBS_STORE (default "acx-matrix")
// - Key prefix: "event:" (MUST match summary reader)

import { getStore } from "@netlify/blobs";

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ---- AUTH (accept either header style) ----
  const secret = process.env.ACX_WEBHOOK_SECRET || "";
  const xSecret = req.headers.get("x-acx-secret") || "";
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const authed = secret && (xSecret === secret || bearer === secret);
  if (!authed) return unauthorized();

  // ---- BODY ----
  let body = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Bad Request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ts = new Date().toISOString();

  const account = String(pick(body, ["account", "account_name"]) || "ACX");
  const location = String(pick(body, ["location", "location_id"]) || "unknown");
  const run_id = String(pick(body, ["run_id", "runId"]) || `run-${Date.now()}`);

  const uptime = toNum(pick(body, ["uptime"]), 0);
  const conversion = toNum(pick(body, ["conversion"]), 0);
  const response_ms = toNum(pick(body, ["response_ms", "responseMs"]), 0);
  const quotes_recovered = toNum(pick(body, ["quotes_recovered", "quotesRecovered"]), 0);

  const integrityRaw = String(pick(body, ["integrity"]) || "unknown").toLowerCase();
  const integrity =
    integrityRaw === "optimal" || integrityRaw === "degraded" || integrityRaw === "critical"
      ? integrityRaw
      : "unknown";

  // ---- WRITE EVENT (MUST match reader: STORE + prefix "event:") ----
  const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
  const store = getStore({ name: storeName });

  const eventKey = `event:${location}:${Date.now()}`;

  const event = {
    ts,
    account,
    location,
    uptime,
    conversion,
    response_ms,
    quotes_recovered,
    integrity,
    run_id,
  };

  try {
    await store.setJSON(eventKey, event);
  } catch (e) {
    console.error("MATRIX_EVENT_WRITE_FAILED", e);
    // still return ok so webhook callers don't fail hard
  }

  return ok({ ok: true, stored: { key: eventKey, store: storeName }, event });
};
