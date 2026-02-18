// functions/acx-matrix-summary.js
// Reads from durable indexes written by acx-matrix-webhook.js
// Auth via x-acx-secret (ACX_WEBHOOK_SECRET)

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

function toInt(v, fallback = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(2000, Math.trunc(n)));
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getIndex(store, key) {
  try {
    const v = await store.getJSON(key);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function safeGetEvent(store, key) {
  try {
    const e = await store.getJSON(key);
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== "GET") return bad("Method Not Allowed", 405);
  if (!authOk(req)) return bad("Unauthorized", 401);

  const url = new URL(req.url);
  const limit = toInt(url.searchParams.get("limit") || "100", 100);

  const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
  const store = getStore({ name: storeName });

  const globalIndexKey = "index:events";
  const keys = await getIndex(store, globalIndexKey);

  if (!keys.length) {
    return json({ ok: true, recent: [], locations: [], series: {}, meta: { store: storeName, index_count: 0 } });
  }

  const takeKeys = keys.slice(0, limit);
  const events = (await Promise.all(takeKeys.map((k) => safeGetEvent(store, k)))).filter(Boolean);

  // recent rows (already newest-first because index is newest-first)
  const recent = events.map((e) => ({
    ts: e.ts,
    account: e.account,
    location: e.location,
    uptime: e.uptime,
    conversion: e.conversion,
    response_ms: e.response_ms,
    quotes_recovered: e.quotes_recovered,
    integrity: e.integrity,
    run_id: e.run_id,
  }));

  // locations = latest-by-location snapshot
  const latestByLoc = new Map();
  for (const e of events) {
    if (!e.location) continue;
    if (!latestByLoc.has(e.location)) latestByLoc.set(e.location, e);
  }

  const locations = Array.from(latestByLoc.values()).map((e) => ({
    location: e.location,
    account: e.account || "",
    last_seen: e.ts,
    uptime: asNum(e.uptime),
    conversion: asNum(e.conversion),
    response_ms: asNum(e.response_ms),
    quotes_recovered: asNum(e.quotes_recovered),
    integrity: (e.integrity || "unknown").toLowerCase(),
  }));

  // series for dashboard sparklines (use per-location indexes)
  const series = {};
  await Promise.all(
    locations.map(async (l) => {
      const locIndexKey = `index:loc:${l.location}`;
      const locKeys = (await getIndex(store, locIndexKey)).slice(0, 120); // 120 points max
      const locEvents = (await Promise.all(locKeys.map((k) => safeGetEvent(store, k)))).filter(Boolean);

      series[l.location] = locEvents.map((e) => ({
        ts: e.ts,
        uptime: asNum(e.uptime),
        conv: asNum(e.conversion),
        resp: asNum(e.response_ms),
        quotes: asNum(e.quotes_recovered),
        integrity: (e.integrity || "unknown").toLowerCase(),
      }));
    })
  );

  return json({
    ok: true,
    recent,
    locations,
    series,
    meta: { store: storeName, index_count: keys.length, returned: events.length },
  });
};
