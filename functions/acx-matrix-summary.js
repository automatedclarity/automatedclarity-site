// functions/acx-matrix-summary.js
// Reads Matrix events from Netlify Blobs (store + key prefix must match writer)
// Auth: x-acx-secret header must equal ACX_WEBHOOK_SECRET (same secret as webhook)

import { getStore } from "@netlify/blobs";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function checkSecret(req) {
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  if (!expected) return true; // allow if not configured (dev)
  const got = (req.headers.get("x-acx-secret") || "").trim();
  return got && got === expected;
}

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function s(v) {
  return (v ?? "").toString();
}

export default async (req) => {
  try {
    if (!checkSecret(req)) return unauthorized();

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 100)));

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // List only keys written by webhook: event:<locationId>:<timestamp>
    // NOTE: Netlify Blobs supports listing by prefix.
    const keys = [];
    for await (const k of store.list({ prefix: "event:" })) {
      keys.push(k);
    }

    // Sort newest first based on trailing timestamp after last ":"
    keys.sort((a, b) => {
      const ta = Number(a.split(":").pop() || 0);
      const tb = Number(b.split(":").pop() || 0);
      return tb - ta;
    });

    const take = keys.slice(0, limit);

    const recent = [];
    const locationsMap = new Map(); // locationId => last event
    const series = {}; // locationId => [{ts, uptime, conv, resp, quotes, integrity}...]

    for (const key of take) {
      const ev = await store.getJSON(key).catch(() => null);
      if (!ev || typeof ev !== "object") continue;

      const row = {
        ts: s(ev.ts),
        account: s(ev.account),
        location: s(ev.location),
        uptime: ev.uptime,
        conversion: ev.conversion,
        response_ms: ev.response_ms,
        quotes_recovered: ev.quotes_recovered,
        integrity: s(ev.integrity),
        run_id: s(ev.run_id),
      };

      recent.push(row);

      const loc = row.location || "unknown";
      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: row.ts,
        uptime: n(row.uptime),
        conv: n(row.conversion),
        resp: n(row.response_ms),
        quotes: n(row.quotes_recovered),
        integrity: (row.integrity || "").toLowerCase() || "unknown",
      });

      // Keep "last seen" per location (newest row wins because we’re iterating newest-first)
      if (!locationsMap.has(loc)) {
        locationsMap.set(loc, {
          location: loc,
          account: row.account,
          last_seen: row.ts,
          uptime: n(row.uptime),
          conversion: n(row.conversion),
          response_ms: n(row.response_ms),
          quotes_recovered: n(row.quotes_recovered),
          integrity: (row.integrity || "").toLowerCase() || "unknown",
        });
      }
    }

    const locations = Array.from(locationsMap.values());

    return json(200, { ok: true, recent, locations, series });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || "Server error" });
  }
};
