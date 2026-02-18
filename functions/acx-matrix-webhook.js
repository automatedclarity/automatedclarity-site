// functions/acx-matrix-webhook.js
// ACX Matrix Webhook (writer)
// - Auth via x-acx-secret (ACX_WEBHOOK_SECRET)
// - Writes event blobs under key: event:<location>:<ms>
// - Maintains durable indexes so summary can read WITHOUT store.list()

import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const bad = (msg, status = 400, extra = {}) => json({ ok: false, error: msg, ...extra }, status);

function authOk(req) {
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  if (!expected) return false;
  const got = (req.headers.get("x-acx-secret") || "").trim();
  return !!got && got === expected;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normIntegrity(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "critical" || s === "degraded" || s === "optimal") return s;
  return "unknown";
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function getIndex(store, key) {
  try {
    const v = await store.getJSON(key);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function addToFrontUnique(list, value, max = 5000) {
  const out = [value, ...list.filter((x) => x !== value)];
  if (out.length > max) out.length = max;
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return bad("Method Not Allowed", 405);

  if (!authOk(req)) return bad("Unauthorized", 401);

  const body = await readJson(req);
  if (!body || typeof body !== "object") return bad("Invalid JSON body", 400);

  const account = String(body.account || body.account_name || "ACX");
  const location = String(body.location || body.location_id || body.locationId || "").trim();
  const run_id = String(body.run_id || body.runId || `run-${Date.now()}`);

  if (!location) return bad("Missing location", 400);

  const event = {
    ts: new Date().toISOString(),
    account,
    location,
    uptime: toNum(body.uptime, 0),
    conversion: toNum(body.conversion, 0),
    response_ms: toNum(body.response_ms, 0),
    quotes_recovered: toNum(body.quotes_recovered, 0),
    integrity: normIntegrity(body.integrity),
    run_id,
  };

  const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
  const store = getStore({ name: storeName });

  const key = `event:${location}:${Date.now()}`;

  // 1) write the event
  await store.setJSON(key, event);

  // 2) update global index + per-location index
  const globalIndexKey = "index:events";
  const locIndexKey = `index:loc:${location}`;

  const [globalIndex, locIndex] = await Promise.all([
    getIndex(store, globalIndexKey),
    getIndex(store, locIndexKey),
  ]);

  const newGlobal = addToFrontUnique(globalIndex, key, 10000);
  const newLoc = addToFrontUnique(locIndex, key, 2000);

  await Promise.all([
    store.setJSON(globalIndexKey, newGlobal),
    store.setJSON(locIndexKey, newLoc),
  ]);

  return json({
    ok: true,
    stored: { key, store: storeName },
    index: { global_count: newGlobal.length, loc_count: newLoc.length },
    event,
  });
};
