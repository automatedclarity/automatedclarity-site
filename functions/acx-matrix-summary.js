// functions/acx-matrix-summary.js
import { checkAuth } from "./_lib/auth.js";
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix_events"; // must match writer
const PFX   = "event:";                                           // must match writer

const MAX_SCAN       = 2000;   // upper bound of blobs to scan (pages)
const DEFAULT_LIMIT  = 100;    // max recent rows to return
const SERIES_POINTS  = 50;     // per-location series length (oldest -> newest)

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok:false, error:"Method Not Allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" }
    });
  }

  // Allow header secret OR cookie session
  const authed =
    checkAuth(req) ||
    (() => { try { return !!readSession(req); } catch { return false; } })();

  if (!authed) {
    return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), DEFAULT_LIMIT);

  const store = getStore(STORE);

  // ---- Collect up to MAX_SCAN blobs under the prefix
  let cursor = undefined;
  const all = [];
  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: PFX, cursor, limit: 200 });
    for (const b of page.blobs || []) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Sort newest-first by uploadedAt (ISO) or by key fallback
  all.sort((a, b) => {
    const au = a.uploadedAt || "";
    const bu = b.uploadedAt || "";
    return au && bu ? bu.localeCompare(au) : b.key.localeCompare(a.key);
  });

  // ---- Fetch bodies for top "limit" -> recent table
  const top = all.slice(0, Math.min(limit, all.length));
  const recent = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      const r = await res.json();
      recent.push({
        ts: r.ts || null,
        account: r.account || r.account_name || "",
        location: r.location || r.location_id || "",
        uptime: r.uptime ?? "",
        conversion: r.conversion ?? "",
        response_ms: r.response_ms ?? "",
        quotes_recovered: r.quotes_recovered ?? "",
        integrity: (r.integrity || "unknown"),
        run_id: r.run_id || ""
      });
    } catch {}
  }

  // ---- Build latest-by-location + series per location
  const latestMap = new Map();                 // loc -> { location, account, last_seen, ... }
  const seriesMap = new Map();                 // loc -> [{ ts, uptime, conv, resp, quotes, integrity }]
  const seenSeriesCounts = new Map();          // loc -> count

  for (const b of all) {
    const res = await store.get(b.key);
    if (!res) continue;
    let item;
    try { item = await res.json(); } catch { continue; }

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account || item.account_name || "unknown";
    const ts  = item.ts || b.uploadedAt || null;

    // latest
    if (!latestMap.has(loc)) {
      latestMap.set(loc, {
        location: loc,
        account: acc,
        last_seen: ts,
        uptime: Number(item.uptime || 0),
        conversion: Number(item.conversion || 0),
        response_ms: Number(item.response_ms || 0),
        quotes_recovered: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase()
      });
    }

    // series
    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    const count = seenSeriesCounts.get(loc) || 0;
    if (count < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase()
      });
      seenSeriesCounts.set(loc, count + 1);
    }

    // Small optimization: if every series reached cap and we already have enough recent, we can stop
    if (recent.length >= limit) {
      let done = true;
      for (const v of seenSeriesCounts.values()) { if (v < SERIES_POINTS) { done = false; break; } }
      if (done) break;
    }
  }

  // Normalize series oldest->newest
  for (const [loc, arr] of seriesMap) {
    arr.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  }

  // Rank severity for locations list
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;                       // severity desc
    return (b.uptime || 0) - (a.uptime || 0);            // uptime desc
  });

  return new Response(JSON.stringify({
    ok: true,
    recent,
    locations,
    series: Object.fromEntries(seriesMap) // { [location]: [{ts,uptime,conv,resp,quotes,integrity}] }
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }});
};
