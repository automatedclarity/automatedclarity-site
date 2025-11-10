// /functions/acx-matrix-summary.js
import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { getStore } from "@netlify/blobs";

/**
 * ACX Matrix — Summary endpoint
 * Returns:
 *  {
 *    ok: true,
 *    recent: [ {ts,account,location,uptime,conversion,response_ms,quotes_recovered,integrity,run_id} ],
 *    locations: [ {location,account,last_seen,uptime,conversion,response_ms,quotes_recovered,integrity} ],
 *    series: { [location]: [{ts,uptime,conv,resp,quotes,integrity}] }
 *  }
 */

// === Tunables (must match your writer) ===========================
const STORE = "acx_matrix_events";   // <— matches /acx-matrix-webhook writer
const KEY_PREFIX = "";               // writer does NOT set a prefix
const MAX_SCAN = 2000;               // total blobs we’ll scan
const DEFAULT_LIMIT = 100;           // cap recent rows
const SERIES_POINTS = 50;            // points per location for charts
// ================================================================

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.min(
    Number(url.searchParams.get("limit") || DEFAULT_LIMIT),
    DEFAULT_LIMIT
  );

  const store = getStore(STORE);

  // 1) List blobs (conditionally apply prefix only if truthy)
  let cursor = undefined;
  const all = [];
  while (all.length < MAX_SCAN) {
    const listOpts = { cursor, limit: 200 };
    if (KEY_PREFIX) listOpts.prefix = KEY_PREFIX; // important: only if non-empty
    const page = await store.list(listOpts);
    for (const b of (page.blobs || [])) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Nothing yet?
  if (all.length === 0) {
    return json({
      ok: true,
      recent: [],
      locations: [],
      series: {}
    });
  }

  // 2) Sort newest->oldest by uploadedAt ISO
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // 3) Fetch bodies for top N recent rows
  const top = all.slice(0, Math.min(limit, all.length));
  const recentRows = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      recentRows.push(await res.json());
    } catch (_) {}
  }

  // 4) Build per-location latest snapshot + small time series (lazy fill)
  const seriesMap = new Map();   // loc -> [{ts,uptime,conv,resp,quotes,integrity}]
  const countsMap = new Map();   // loc -> count filled
  const latestMap = new Map();   // loc -> latest snapshot

  for (const b of all) {
    const res = await store.get(b.key);
    if (!res) continue;

    let item;
    try { item = await res.json(); } catch { continue; }

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account || item.account_name || "unknown";

    // latest snapshot (first time we see a location in newest->oldest order)
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

    // initialize series holders
    if (!seriesMap.has(loc)) seriesMap.set(loc, []);
    if (!countsMap.has(loc)) countsMap.set(loc, 0);

    // append to series up to SERIES_POINTS
    const filled = countsMap.get(loc);
    if (filled < SERIES_POINTS) {
      seriesMap.get(loc).push({
        ts: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "").toLowerCase(),
      });
      countsMap.set(loc, filled + 1);
    }

    // early exit if every location reached the point cap AND we already read recentRows
    let allFilled = true;
    for (const v of countsMap.values()) {
      if (v < SERIES_POINTS) { allFilled = false; break; }
    }
    if (allFilled && recentRows.length >= limit) break;
  }

  // Normalize series oldest->newest
  for (const arr of seriesMap.values()) {
    arr.sort((a, b) => (a.ts > b.ts ? 1 : -1));
  }

  // Rank latest locations by severity then uptime
  const sevOrder = { critical: 3, degraded: 2, optimal: 1, unknown: 0 };
  const locations = [...latestMap.values()].sort((a, b) => {
    const sa = sevOrder[a.integrity] ?? 0;
    const sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  // Normalize recent rows for the table
  const outRows = recentRows.map(r => ({
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

  return json({
    ok: true,
    recent: outRows,
    locations,
    series: Object.fromEntries(seriesMap),
  });
};

// Utility
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
