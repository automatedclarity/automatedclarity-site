// functions/acx-matrix-summary.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = "acx_matrix";
const KEY_PREFIX = "matrix:";
const MAX_SCAN = 2000;
const DEFAULT_LIMIT = 100;
const SERIES_POINTS = 50;

export default async (req) => {
  // Require login session
  if (!readSession(req)) return new Response(JSON.stringify({ ok:false }), { status:401 });

  if (req.method !== "GET")
    return new Response(JSON.stringify({ ok:false, error:"Method Not Allowed" }), { status:405 });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), DEFAULT_LIMIT);

  const store = getStore(STORE);

  // Gather blob list (newest later—will sort)
  let cursor = undefined;
  const all = [];
  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    (page.blobs || []).forEach(b => all.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Newest first
  all.sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Load top N
  const top = all.slice(0, Math.min(limit, all.length));
  const rows = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try { rows.push(await res.json()); } catch {}
  }

  // Per-location latest + series
  const seriesMap = new Map(); // loc -> [{ts, uptime, conv, resp, quotes, integrity}]
  const latestMap = new Map();
  const counts = new Map();

  for (const b of all) {
    const res = await store.get(b.key);
    if (!res) continue;
    let item; try { item = await res.json(); } catch { continue; }

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account || item.account_name || "unknown";

    if (!latestMap.has(loc)) {
      latestMap.set(loc, {
        location: loc,
        account: acc,
        last_seen: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conversion: Number(item.conversion || 0),
        response_ms: Number(item.response_ms || 0),
        quotes_recovered: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase(),
      });
    }

    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    if (!counts.has(loc)) counts.set(loc, 0);
    const n = counts.get(loc);
    if (n < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "").toLowerCase()
      });
      counts.set(loc, n+1);
    }

    // Early stop if all series filled and we already read enough for table
    let done = true;
    for (const [, c] of counts) { if (c < SERIES_POINTS) { done = false; break; } }
    if (done && rows.length >= limit) break;
  }

  for (const [, arr] of seriesMap) arr.sort((a,b)=> (a.ts > b.ts ? 1 : -1));

  const sevOrder = { critical:3, degraded:2, optimal:1, unknown:0 };
  const locations = [...latestMap.values()].sort((a,b) => {
    const sa = sevOrder[a.integrity] ?? 0, sb = sevOrder[b.integrity] ?? 0;
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
    ok:true,
    recent: outRows,
    locations,
    series: Object.fromEntries(seriesMap)
  }), { headers: { "Content-Type":"application/json" }});
};
