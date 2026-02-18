// functions/acx-matrix-summary.js
import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function normalizeIndex(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object" && Array.isArray(raw.keys)) return raw.keys.map(String).filter(Boolean);
  return [];
}

async function readJSON(store, key) {
  try {
    const v = await store.get(key, { type: "json" });
    if (v == null) return null;
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    try {
      const s = await store.get(key);
      if (s == null) return null;
      if (typeof s === "string") return JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  }
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export default async (req) => {
  try {
    if (req.method !== "GET") return json({ ok: false, error: "Method Not Allowed" }, 405);

    // ✅ dashboard access uses session cookie, not x-acx-secret
    const s = requireSession(req);
    if (!s.ok) return s.response;

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)));

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const idxRaw = await readJSON(store, "index:events");
    const keys = normalizeIndex(idxRaw);
    const index_count = keys.length;

    // newest last in our index, so read from the end
    const tail = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const events = [];
    for (const k of tail) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") events.push(ev);
    }

    // Locations summary = most recent per location
    const byLoc = new Map();
    for (const ev of events) {
      const loc = String(ev.location || "");
      if (!loc) continue;
      if (!byLoc.has(loc)) byLoc.set(loc, ev); // events already newest-first
    }

    const locations = Array.from(byLoc.values()).map((ev) => ({
      location: String(ev.location || ""),
      account: String(ev.account || ""),
      last_seen: String(ev.ts || ""),
      uptime: toNum(ev.uptime),
      conversion: toNum(ev.conversion),
      response_ms: toNum(ev.response_ms),
      quotes_recovered: toNum(ev.quotes_recovered),
      integrity: String(ev.integrity || "unknown").toLowerCase(),
    }));

    // Series (simple) = per-location last N points from this response window
    const series = {};
    for (const ev of events.slice().reverse()) {
      const loc = String(ev.location || "");
      if (!loc) continue;
      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: ev.ts,
        uptime: toNum(ev.uptime),
        conv: toNum(ev.conversion),
        resp: toNum(ev.response_ms),
        quotes: toNum(ev.quotes_recovered),
        integrity: String(ev.integrity || "unknown").toLowerCase(),
      });
    }

    return json({
      ok: true,
      recent: events,
      locations,
      series,
      meta: { store: storeName, index_count },
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
