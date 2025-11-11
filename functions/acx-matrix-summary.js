// Cookie-auth Summary for ACX Matrix Dashboard
import { requireAuth } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX   = "event:";           // MUST match writer
const DEFAULT_LIMIT = 100;
const SERIES_POINTS = 50;

export default async (req) => {
  // Browser hits this with the acx_session cookie
  const guard = requireAuth(req);
  if (guard) return guard; // 401 JSON when not signed in

  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), DEFAULT_LIMIT);

  const store = getStore({ name: STORE });

  // List newest-first
  const page = await store.list({ prefix: PFX, limit: 2000 });
  const blobs = (page.blobs || []).sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Recent rows (limited)
  const rows = [];
  for (const b of blobs.slice(0, limit)) {
    const r = await store.get(b.key);
    if (!r) continue;
    try { rows.push(await r.json()); } catch {}
  }

  // Build latest-per-location + time series
  const latest = new Map();
  const series = new Map();
  const seen   = new Map();

  for (const b of blobs) {
    const r = await store.get(b.key);
    if (!r) continue;
    let item; try { item = await r.json(); } catch { continue; }

    const loc = item.location || item.location_id || "unknown";
    const acc = item.account  || item.account_name || "unknown";

    if (!latest.has(loc)) {
      latest.set(loc, {
        location: loc, account: acc, last_seen: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conversion: Number(item.conversion || 0),
        response_ms: Number(item.response_ms || 0),
        quotes_recovered: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "unknown").toLowerCase()
      });
    }

    if (!series.has(loc)) series.set(loc, []);
    if (!seen.has(loc))   seen.set(loc, 0);

    const c = seen.get(loc);
    if (c < SERIES_POINTS) {
      series.get(loc).push({
        ts: item.ts || b.uploadedAt,
        uptime: Number(item.uptime || 0),
        conv: Number(item.conversion || 0),
        resp: Number(item.response_ms || 0),
        quotes: Number(item.quotes_recovered || 0),
        integrity: (item.integrity || "").toLowerCase()
      });
      seen.set(loc, c + 1);
    }
  }

  for (const arr of series.values()) arr.sort((a,b) => (a.ts > b.ts ? 1 : -1));

  const sevOrder = { critical:3, degraded:2, optimal:1, unknown:0 };
  const locations = [...latest.values()].sort((a,b) => {
    const sa = sevOrder[a.integrity] ?? 0, sb = sevOrder[b.integrity] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.uptime || 0) - (a.uptime || 0);
  });

  return new Response(JSON.stringify({
    ok: true,
    recent: rows,
    locations,
    series: Object.fromEntries(series),
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
