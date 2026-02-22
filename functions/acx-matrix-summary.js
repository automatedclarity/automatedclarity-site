// /netlify/functions/acx-matrix-summary.js
// - Returns recent events + per-location rollups + series
// - Auth: allows either x-acx-secret OR logged-in session
// - Normalizes/filters junk location like "[object Object]"

import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { requireSession } from "./_lib/session.js";
import { storeGetRecent, storeGetLocations, storeGetSeries } from "./_lib/matrixStore.js"; 
// ^ keep your existing store layer imports; if your filenames differ, keep SAME logic below.

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const normalizeIntegrity = (raw) => {
  const v = String(raw || "").trim().toLowerCase();
  // Accept both naming styles coming from different sources:
  // - GHL/Form: ok / degraded / critical
  // - Older: optimal
  if (v === "ok" || v === "optimal") return "optimal";
  if (v === "degraded") return "degraded";
  if (v === "critical") return "critical";
  return "unknown";
};

const normalizeLocation = (loc) => {
  if (loc == null) return "";
  if (typeof loc === "string") {
    const s = loc.trim();
    if (!s) return "";
    if (s === "[object Object]") return ""; // filter junk row
    return s;
  }
  // If someone accidentally sent an object, drop it
  return "";
};

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();

  // ---- AUTH (EMPIRE) ----
  // Allow EITHER:
  // 1) x-acx-secret header (CLI/curl + server-to-server)
  // 2) logged-in session cookie (browser dashboard)
  const authedBySecret = checkAuth(req);
  let authedBySession = false;

  if (!authedBySecret) {
    try {
      await requireSession(req); // throws if not logged in
      authedBySession = true;
    } catch {
      return unauthorized();
    }
  }

  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const staleMinutes = Math.min(1440, Math.max(1, Number(url.searchParams.get("stale") || 10)));

  // ---- LOAD ----
  const recentRaw = await storeGetRecent({ limit });
  const locationsRaw = await storeGetLocations();
  const seriesRaw = await storeGetSeries({ limit: 500 });

  // ---- NORMALIZE ----
  const recent = (recentRaw || []).map((e) => {
    const location = normalizeLocation(e.location);
    const integrity = normalizeIntegrity(e.acx_integrity ?? e.integrity);
    return {
      ...e,
      location,
      integrity,
      uptime: toNum(e.uptime),
      conversion: toNum(e.conversion),
      response_ms: toNum(e.response_ms),
      quotes_recovered: toNum(e.quotes_recovered),
    };
  });

  // Filter any events with bad location so they don’t create ghost rows
  const recentFiltered = recent.filter((e) => !!e.location);

  const locations = (locationsRaw || [])
    .map((l) => {
      const location = normalizeLocation(l.location);
      const integrity = normalizeIntegrity(l.integrity ?? l.acx_integrity);
      return {
        ...l,
        location,
        integrity,
        uptime: toNum(l.uptime),
        conversion: toNum(l.conversion),
        response_ms: toNum(l.response_ms),
        quotes_recovered: toNum(l.quotes_recovered),
      };
    })
    .filter((l) => !!l.location);

  // series: keep only valid locations
  const series = {};
  for (const [loc, points] of Object.entries(seriesRaw || {})) {
    const nloc = normalizeLocation(loc);
    if (!nloc) continue;
    series[nloc] = (points || []).map((p) => ({
      ts: p.ts,
      uptime: toNum(p.uptime ?? p.upt ?? 0),
      conv: toNum(p.conversion ?? p.conv ?? 0),
      resp: toNum(p.response_ms ?? p.resp ?? 0),
      quotes: toNum(p.quotes_recovered ?? p.quotes ?? 0),
      integrity: normalizeIntegrity(p.integrity ?? p.acx_integrity),
    }));
  }

  // meta block — keep whatever you already had (wf3 stats etc.)
  const meta = {
    store: "acx-matrix",
    stale_minutes: staleMinutes,
    auth: authedBySecret ? "secret" : authedBySession ? "session" : "unknown",
  };

  return json(200, {
    ok: true,
    recent: recentFiltered,
    locations,
    series,
    meta,
  });
};
