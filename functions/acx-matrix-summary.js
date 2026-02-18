// netlify/functions/acx-matrix-summary.js
// Reads Matrix events from Netlify Blobs store and returns:
// - recent: latest N events
// - locations: latest per location (summary rows)
// - series: per-location time series for sparklines
//
// AUTH:
// - Accepts x-acx-secret header (server-to-server / curl)
// - OR valid session cookie (browser dashboard)

import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function okSecret(req) {
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim(); // same secret you used in curl
  if (!expected) return false;

  const got =
    (req.headers.get("x-acx-secret") || "").trim() ||
    (req.headers.get("x-acx_secret") || "").trim();

  return !!got && got === expected;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default async (req) => {
  try {
    if (req.method !== "GET") return json(405, { ok: false, error: "Method Not Allowed" });

    // --- AUTH (either header secret OR session cookie) ---
    if (!okSecret(req)) {
      // If no secret header, require dashboard session cookie
      // (this throws if missing/invalid)
      requireSession(req);
    }

    const url = new URL(req.url);
    const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 100);

    const storeName = (process.env.ACX_BLOBS_STORE || "acx-matrix").trim();
    const store = getStore({ name: storeName });

    // We store events as keys: event:<location>:<tsMillis>
    // We'll list and take the latest ones.
    const listed = await store.list({ prefix: "event:" });

    const keys = (listed?.blobs || [])
      .map((b) => b?.key)
      .filter(Boolean)
      .sort((a, b) => {
        // Sort by trailing timestamp (numerical) desc if present, else lexical desc
        const ta = Number(String(a).split(":").pop());
        const tb = Number(String(b).split(":").pop());
        if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
        return b.localeCompare(a);
      });

    const recentKeys = keys.slice(0, limit);

    const recent = [];
    for (const k of recentKeys) {
      try {
        const e = await store.getJSON(k);
        if (e) recent.push(e);
      } catch {
        // ignore single bad blob
      }
    }

    // locations summary: take latest event per location
    const latestByLoc = new Map();
    for (const e of recent) {
      const loc = String(e.location || "");
      if (!loc) continue;
      if (!latestByLoc.has(loc)) latestByLoc.set(loc, e);
    }

    // BUT if limit is small, you may not see all locations.
    // So: build latest-per-location by scanning keys until we have enough.
    // (cap scan to keep it fast)
    const MAX_SCAN = 3000;
    let scanned = 0;
    if (latestByLoc.size < 200) {
      for (const k of keys) {
        if (scanned++ > MAX_SCAN) break;
        const parts = String(k).split(":");
        const loc = parts[1] || "";
        if (!loc) continue;
        if (latestByLoc.has(loc)) continue;
        try {
          const e = await store.getJSON(k);
          if (e) latestByLoc.set(loc, e);
        } catch {}
      }
    }

    const locations = Array.from(latestByLoc.entries()).map(([loc, e]) => ({
      location: String(loc),
      account: String(e.account || ""),
      last_seen: String(e.ts || ""),
      uptime: toNum(e.uptime),
      conversion: toNum(e.conversion),
      response_ms: toNum(e.response_ms),
      quotes_recovered: toNum(e.quotes_recovered),
      integrity: String(e.integrity || "unknown").toLowerCase(),
    }));

    // series: per location list of points for sparklines
    // We’ll build from recent + (optionally) a little extra scan for each location.
    const series = {};
    for (const e of recent) {
      const loc = String(e.location || "");
      if (!loc) continue;
      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: e.ts,
        uptime: toNum(e.uptime),
        conv: toNum(e.conversion),
        resp: toNum(e.response_ms),
        quotes: toNum(e.quotes_recovered),
        integrity: String(e.integrity || "unknown").toLowerCase(),
      });
    }

    // Ensure series is sorted ascending by ts for charting
    for (const loc of Object.keys(series)) {
      series[loc].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    }

    return json(200, { ok: true, recent, locations, series });
  } catch (err) {
    // If session invalid, force dashboard back to login
    if (String(err?.message || "").toLowerCase().includes("unauthorized")) {
      return json(401, { ok: false, error: "Unauthorized" });
    }
    return json(500, { ok: false, error: err?.message || "Unknown error" });
  }
};
