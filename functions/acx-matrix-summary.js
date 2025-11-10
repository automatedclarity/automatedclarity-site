// /functions/acx-matrix-summary.js
import { requireAuth } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

// Tunables
const STORE = "acx_matrix";
const KEY_PREFIX = "matrix:";               // how writer stores records
const MAX_SCAN = 2000;                      // upper bound of blobs to scan
const DEFAULT_LIMIT = 100;                  // max recent rows to return
const SERIES_POINTS = 50;                   // per-location series length

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const guard = requireAuth(req);
  if (guard) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(
    Number(url.searchParams.get("limit") || DEFAULT_LIMIT),
    DEFAULT_LIMIT
  );

  const store = getStore(STORE);

  // Pull recent blobs by pages until we have enough
  let cursor = undefined;
  const all = [];

  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    for (const b of page.blobs || []) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Sort newest first by uploadedAt (ISO)
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Fetch bodies for the top N (for the "recent" table)
  const top = all.slice(0, Math.min(limit, all.length));
  const rows = [];
  for (const b of top) {
    try {
      const v = await store.get(b.key, { type: "json" });
      if (v) rows.push(v);
    } catch {}
  }

  // Build latest snapshot per location + time series
  const seriesMap = new Map();  // loc -> [{ts, uptime, conv, resp, quotes, integrity}]
  const latestMap = new Map();  // loc -> latest row
  const seenSeriesCounts = new Map();

  for (const b of all.slice(0, MAX_SCAN)) {
    let item;
    try {
      item = await store.get(b.key, { type: "json" });
    } catch {
      continue;
    }
    if (!item) continue;

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account || item.account_name || "unknown";
    const ts  = item.ts || b.uploadedAt;

    // Latest snapshot per location (first encounter after sort is newest)
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

    // Series (cap per location)
    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    if (!seenSeriesCounts.has(loc)) seenSeriesCounts.set(loc, 0);

    const count = seenSeriesCounts.get(loc);
    if (count < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "").toLowerCase()
      });
      seenSeriesCounts.set(loc, count + 1);
    }

    // Early exit if all series filled and we already fetched recent rows
    let doneSeries = true;
    for (const [_k, v] of seenSeriesCounts) { if (v < SERIES_POINTS) { doneSeries = false; break; } }
    if (doneSeries && rows.length >= limit) break;
  }

  // Normalize series oldest->newest
  for (const [k, arr] of seriesMap) {
    arr.sort((a, b) => (a.ts > b.ts ? 1 : -1));
  }

  // Rank severity
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };

  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  const outRows = rows.map(r => ({
    ts: r.ts || null,
    account: r.account || r.account_name || "",
    location: r.location || r.location_id || "",
    uptime: r.uptime ?? "",
    conversion: r.conversion ?? "",
    response_ms: r.response_ms ?? "",
    quotes_recovered: r.quotes_recovered ?? "",
    integrity: r.integrity || "unknown",
    run_id: r.run_id || ""
  }));

  return new Response(JSON.stringify({
    ok: true,
    recent: outRows,
    locations,
    series: Object.fromEntries(seriesMap), // { [location]: [{ts,uptime,conv,resp,quotes,integrity}] }
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
