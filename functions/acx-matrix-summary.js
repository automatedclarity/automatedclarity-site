// functions/acx-matrix-summary.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

// Config
const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix";
const KEY_PREFIX = "matrix:";        // how the writer stores rows
const DEFAULT_LIMIT = 100;           // recent rows to include
const SERIES_POINTS = 50;            // history length per location
const MAX_SCAN = 2000;               // upper bound of blobs to scan

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ✅ Cookie/session auth (no x-acx-secret header)
  const sess = readSession(req);
  if (!sess) return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" }
  });

  const url = new URL(req.url, "http://x");
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), DEFAULT_LIMIT));

  const store = getStore(STORE);

  // 1) List recent blobs (newest first by uploadedAt)
  let cursor; const all = [];
  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    (page.blobs || []).forEach(b => all.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }
  all.sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // 2) Fetch bodies for top N recent rows
  const top = all.slice(0, Math.min(limit, all.length));
  const recent = [];
  for (const b of top) {
    const body = await store.get(b.key);
    if (!body) continue;
    try { recent.push(await body.json()); } catch {}
  }

  // 3) Build latest-per-location + short series
  const latestMap = new Map();            // loc -> latest row
  const seriesMap = new Map();            // loc -> [{ts,uptime,conv,resp,quotes,integrity}]
  const seenCounts = new Map();           // loc -> count filled

  for (const b of all) {
    const body = await store.get(b.key);
    if (!body) continue;
    let row; try { row = await body.json(); } catch { continue; }

    const loc = row.location || row.location_id || "unknown";
    const acc = row.account  || row.account_name || "unknown";
    const ts  = row.ts || b.uploadedAt;

    if (!latestMap.has(loc)) {
      latestMap.set(loc, {
        location: loc,
        account: acc,
        last_seen: ts,
        uptime: Number(row.uptime || 0),
        conversion: Number(row.conversion || 0),
        response_ms: Number(row.response_ms || 0),
        quotes_recovered: Number(row.quotes_recovered || 0),
        integrity: String(row.integrity || "unknown").toLowerCase(),
      });
    }

    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    if (!seenCounts.has(loc)) seenCounts.set(loc, 0);

    const c = seenCounts.get(loc);
    if (c < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts, uptime: Number(row.uptime || 0),
        conv: Number(row.conversion || 0),
        resp: Number(row.response_ms || 0),
        quotes: Number(row.quotes_recovered || 0),
        integrity: String(row.integrity || "unknown").toLowerCase()
      });
      seenCounts.set(loc, c + 1);
    }

    // Stop early if we filled all series and recent already fetched
    let allFilled = true;
    for (const [,v] of seenCounts) { if (v < SERIES_POINTS) { allFilled = false; break; } }
    if (allFilled && recent.length >= limit) break;
  }

  // Normalize series oldest->newest
  for (const [k, arr] of seriesMap) arr.sort((a,b)=> (a.ts > b.ts ? 1 : -1));

  // Rank locations by severity then uptime
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a,b)=>{
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  // Normalize rows for table
  const outRows = recent.map(r => ({
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
    series: Object.fromEntries(seriesMap),
  }), { headers: { "Content-Type": "application/json" }});
};
