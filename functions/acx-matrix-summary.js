// functions/acx-matrix-summary.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix"; // <-- use env (same as writer)
const KEY_PREFIX = "matrix:";          // writer uses this
const MAX_SCAN = 2000;
const DEFAULT_LIMIT = 100;
const SERIES_POINTS = 50;

export default async (req) => {
  // Cookie session only
  const sess = readSession(req);
  if (!sess) return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), { status:401 });

  if (req.method !== "GET")
    return new Response("Method Not Allowed", { status:405 });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), DEFAULT_LIMIT);

  const store = getStore(STORE);

  // List newest first
  let cursor;
  const all = [];
  while (all.length < MAX_SCAN) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    (page.blobs || []).forEach(b => all.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }
  all.sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Load bodies for recent table
  const top = all.slice(0, Math.min(limit, all.length));
  const recent = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try { recent.push(await res.json()); } catch {}
  }

  // Build per-location latest + series
  const latestMap = new Map();        // loc -> latest row
  const seriesMap = new Map();        // loc -> [{ts,uptime,conv,resp,quotes,integrity}]
  const seenSeriesCounts = new Map(); // loc -> count

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
    if (!seenSeriesCounts.has(loc)) seenSeriesCounts.set(loc, 0);

    const count = seenSeriesCounts.get(loc);
    if (count < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "").toLowerCase(),
      });
      seenSeriesCounts.set(loc, count + 1);
    }

    // Stop early if we’ve filled all series AND already loaded recent
    let doneSeries = true;
    for (const v of seenSeriesCounts.values()) { if (v < SERIES_POINTS) { doneSeries = false; break; } }
    if (doneSeries && recent.length >= limit) break;
  }

  // Oldest→newest for charts
  for (const arr of seriesMap.values()) arr.sort((a,b) => (a.ts > b.ts ? 1 : -1));

  // Severity ranking
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

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
  }), { headers: { "Content-Type": "application/json" } });
};
