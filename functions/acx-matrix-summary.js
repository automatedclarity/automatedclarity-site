// netlify/functions/acx-matrix-summary.js
// ACX Matrix summary endpoint
// - Reads events + per-location summaries from Netlify Blobs store "acx-matrix"
// - Returns { ok, recent, locations, series, meta }
// - AUTH: accepts x-acx-secret and checks ACX_SECRET OR ACX_WEBHOOK_SECRET (backward compatible)

import { getStore } from "@netlify/blobs";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-acx-secret",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });

const methodNotAllowed = () => json(405, { ok: false, error: "Method Not Allowed" });
const unauthorized = () => json(401, { ok: false, error: "Unauthorized" });

const checkAuth = (req) => {
  const expected =
    process.env.ACX_SECRET ||
    process.env.ACX_WEBHOOK_SECRET || // backward compatible name
    "";

  if (!expected) return false;

  const got =
    req.headers.get("x-acx-secret") ||
    req.headers.get("X-ACX-SECRET") ||
    "";

  return !!got && got === expected;
};

// ---------- helpers ----------
const asNumber = (v, fallback = 0) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function getJson(store, key, fallback) {
  try {
    const raw = await store.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function safeLoadEvent(store, key) {
  try {
    const raw = await store.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickIntegrity(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "critical") return "critical";
  if (s === "degraded") return "degraded";
  if (s === "optimal") return "optimal";
  if (s === "unknown") return "unknown";
  return "unknown";
}

// ---------- main ----------
export default async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(1000, asNumber(url.searchParams.get("limit"), 100)));
  const account = (url.searchParams.get("account") || "ACX").trim() || "ACX";

  const store = getStore("acx-matrix");

  // Global index of event keys (newest first)
  const globalIndexKey = "index:global";
  const globalIndex = await getJson(store, globalIndexKey, []);
  const keys = Array.isArray(globalIndex) ? globalIndex.slice(0, limit) : [];

  // Load recent events (best-effort)
  const recent = [];
  for (const k of keys) {
    const ev = await safeLoadEvent(store, k);
    if (ev) recent.push(ev);
  }

  // Locations list for account
  const locListKey = `locations:${account}`;
  const locations = await getJson(store, locListKey, []);

  // Build simple series per location from the most recent events
  // (kept small so dashboard charts stay fast)
  const series = {};
  const MAX_SERIES_POINTS = 50;

  for (const ev of recent) {
    const loc = ev?.location;
    if (!loc) continue;

    if (!series[loc]) series[loc] = [];
    if (series[loc].length >= MAX_SERIES_POINTS) continue;

    series[loc].push({
      ts: ev.ts,
      uptime: asNumber(ev.uptime, 0),
      conv: asNumber(ev.conversion, 0),
      resp: asNumber(ev.response_ms, 0),
      quotes: asNumber(ev.quotes_recovered, 0),
      integrity: pickIntegrity(ev.integrity || ev.acx_integrity),
    });
  }

  // Ensure each location series is oldest -> newest for charting
  for (const loc of Object.keys(series)) {
    series[loc].reverse();
  }

  // Minimal meta block (extend later)
  const meta = {
    store: "acx-matrix",
    index_count: Array.isArray(globalIndex) ? globalIndex.length : 0,
  };

  return json(200, {
    ok: true,
    recent,
    locations: Array.isArray(locations) ? locations : [],
    series,
    meta,
  });
};
