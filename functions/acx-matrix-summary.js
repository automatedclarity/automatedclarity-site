// ACX Matrix — Summary (cards + series + table) for /public/matrix.html
import { getStore } from "@netlify/blobs";

const STORE  = "acx_matrix_events";  // <- forced match
const PREFIX = "event:";             // <- forced match
const MAX_SCAN = 2000;
const DEFAULT_LIMIT = 100;
const SERIES_POINTS = 50;

function fnum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok:false, error:"Method Not Allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), 1000);

  const store = getStore(STORE);

  // Fetch a window of blobs under the prefix
  let cursor; const all = [];
  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: PREFIX, cursor, limit: 200 });
    (page.blobs || []).forEach(b => all.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }

  // newest first
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Grab bodies for the first N to render "recent" table quickly
  const top = all.slice(0, Math.min(limit, all.length));
  const recent = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      const r = await res.json();
      recent.push({
        ts: r.ts || b.uploadedAt,
        account: r.account || "",
        location: r.location || "",
        uptime: r.uptime ?? "",
        conversion: r.conversion ?? "",
        response_ms: r.response_ms ?? "",
        quotes_recovered: r.quotes_recovered ?? "",
        integrity: (r.integrity || "unknown"),
        run_id: r.run_id || "",
      });
    } catch {}
  }

  // Build latest-by-location + short series per location
  const latestMap = new Map(); // loc -> latest row
  const seriesMap = new Map(); // loc -> [{ts, uptime, conv, resp, quotes, integrity}]

  for (const b of all) {
    const res = await store.get(b.key);
    if (!res) continue;
    let item;
    try { item = await res.json(); } catch { continue; }

    const loc = item.location || "unknown";
    const acc = item.account || "unknown";

    // Latest snapshot for cards
    if (!latestMap.has(loc)) {
      latestMap.set(loc, {
        location: loc,
        account: acc,
        last_seen: item.ts || b.uploadedAt,
        uptime: fnum(item.uptime),
        conversion: fnum(item.conversion),
        response_ms: fnum(item.response_ms),
        quotes_recovered: fnum(item.quotes_recovered),
        integrity: (item.integrity || "unknown").toLowerCase(),
      });
    }

    // Series (cap at SERIES_POINTS per location)
    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    const arr = seriesMap.get(loc);
    if (arr.length < SERIES_POINTS) {
      arr.push({
        ts: item.ts || b.uploadedAt,
        uptime: fnum(item.uptime),
        conv: fnum(item.conversion),
        resp: fnum(item.response_ms),
        quotes: fnum(item.quotes_recovered),
        integrity: (item.integrity || "unknown").toLowerCase(),
      });
    }

    // stop early if every series reached cap and we already have enough table rows
    let full = true;
    for (const [_k, v] of seriesMap) { if (v.length < SERIES_POINTS) { full = false; break; } }
    if (full && recent.length >= limit) break;
  }

  // Normalize series oldest->newest
  for (const [k, arr] of seriesMap) {
    arr.sort((a, b) => (a.ts > b.ts ? 1 : -1));
  }

  // Rank locations by severity then uptime
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  return new Response(JSON.stringify({
    ok: true,
    recent,
    locations,
    series: Object.fromEntries(seriesMap),
  }), { headers: { "Content-Type": "application/json" }});
};
