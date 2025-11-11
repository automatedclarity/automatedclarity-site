// /functions/acx-matrix-summary.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

// Tunables
const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix";
const KEY_PREFIX = "matrix:";          // how writer stores records
const MAX_SCAN = 2000;                 // upper bound of blobs to scan
const DEFAULT_LIMIT = 100;             // max recent rows to return
const SERIES_POINTS = 50;              // per-location series length

export default async (req) => {
  // ✅ Gate by cookie session (no x-acx-secret here)
  const sess = readSession(req);
  if (!sess) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Number(url.searchParams.get("limit") || DEFAULT_LIMIT),
    1000 // clamp hard upper bound for UI control
  );

  const store = getStore(STORE);

  // List blobs newest-first (manual sort by uploadedAt)
  let cursor;
  const all = [];
  while (all.length < Math.min(MAX_SCAN, limit * 20)) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    for (const b of page.blobs || []) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Pull top N bodies for the “Recent” table
  const top = all.slice(0, Math.min(limit, all.length));
  const recentRows = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      const item = await res.json();
      recentRows.push({
        ts: item.ts || b.uploadedAt || null,
        account: item.account || item.account_name || "",
        location: item.location || item.location_id || "",
        uptime: item.uptime ?? "",
        conversion: item.conversion ?? "",
        response_ms: item.response_ms ?? "",
        quotes_recovered: item.quotes_recovered ?? "",
        integrity: (item.integrity || "unknown"),
        run_id: item.run_id || ""
      });
    } catch {}
  }

  // Build latest-per-location + short series per location
  const latestMap = new Map();     // loc -> latest obj
  const seriesMap = new Map();     // loc -> [{ts,uptime,conv,resp,quotes,integrity}]
  const counts = new Map();        // loc -> count

  for (const b of all) {
    const res = await store.get(b.key);
    if (!res) continue;
    let item; try { item = await res.json(); } catch { continue; }

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account || item.account_name || "unknown";
    const ts  = item.ts || b.uploadedAt;

    if (!latestMap.has(loc)) {
      latestMap.set(loc, {
        location: loc,
        account: acc,
        last_seen: ts,
        uptime: Number(item.uptime || 0),
        conversion: Number(item.conversion || 0),
        response_ms: Number(item.response_ms || 0),
        quotes_recovered: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase(),
      });
    }
    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    if (!counts.has(loc)) counts.set(loc, 0);

    const c = counts.get(loc);
    if (c < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase(),
      });
      counts.set(loc, c + 1);
    }

    // Early exit: we have enough for everyone and enough recents
    let filledAll = true;
    for (const [, n] of counts) if (n < SERIES_POINTS) { filledAll = false; break; }
    if (filledAll && recentRows.length >= limit) break;
  }

  // Normalize series oldest -> newest
  for (const [k, arr] of seriesMap) {
    arr.sort((a, b) => (a.ts > b.ts ? 1 : -1));
  }

  // Sort locations by severity, then uptime
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  return new Response(JSON.stringify({
    ok: true,
    recent: recentRows,
    locations,
    series: Object.fromEntries(seriesMap),
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
