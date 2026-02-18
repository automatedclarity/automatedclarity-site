// functions/acx-matrix-summary.js
import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function parseIntSafe(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function getMsFromKey(key) {
  // event:<locationId>:<ms>
  const parts = String(key || "").split(":");
  const ms = parts.length >= 3 ? parseIntSafe(parts[2], 0) : 0;
  return ms;
}

function authOk(req) {
  const header = (req.headers.get("x-acx-secret") || "").trim();
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  if (expected && header && header === expected) return true;
  return false;
}

export default async (req) => {
  try {
    if (req.method !== "GET") return json(405, { ok: false, error: "Method Not Allowed" });

    // Auth: either valid session cookie OR x-acx-secret (terminal access)
    if (!authOk(req)) {
      const gate = requireSession(req);
      if (!gate.ok) return gate.response;
    }

    const url = new URL(req.url);
    const limit = Math.min(1000, Math.max(1, parseIntSafe(url.searchParams.get("limit") || "50", 50)));

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore(storeName);

    // Correct API: list() returns { blobs, directories } :contentReference[oaicite:2]{index=2}
    const { blobs } = await store.list({ prefix: "event:" });
    const keys = (blobs || []).map((b) => b.key);

    // Sort newest first using the ms suffix we write in the key
    keys.sort((a, b) => getMsFromKey(b) - getMsFromKey(a));

    const take = keys.slice(0, limit);

    const recent = [];
    for (const k of take) {
      try {
        const ev = await store.getJSON(k);
        if (ev) recent.push(ev);
      } catch {
        // ignore single bad blob
      }
    }

    // Aggregate latest per location
    const byLoc = new Map();
    for (const r of recent) {
      const loc = String(r.location || "");
      if (!loc) continue;
      // first encountered is newest due to sort order
      if (!byLoc.has(loc)) byLoc.set(loc, r);
    }

    const locations = Array.from(byLoc.values()).map((r) => ({
      location: String(r.location || ""),
      account: String(r.account || ""),
      last_seen: String(r.ts || ""),
      uptime: Number(r.uptime || 0),
      conversion: Number(r.conversion || 0),
      response_ms: Number(r.response_ms || 0),
      quotes_recovered: Number(r.quotes_recovered || 0),
      integrity: String(r.integrity || "unknown").toLowerCase(),
    }));

    // Build a tiny series per location (up to 30 points from 'recent')
    const series = {};
    for (const r of recent.slice().reverse()) {
      const loc = String(r.location || "");
      if (!loc) continue;
      series[loc] ||= [];
      if (series[loc].length >= 30) continue;
      series[loc].push({
        ts: r.ts,
        uptime: Number(r.uptime || 0),
        conv: Number(r.conversion || 0),
        resp: Number(r.response_ms || 0),
        quotes: Number(r.quotes_recovered || 0),
        integrity: String(r.integrity || "unknown").toLowerCase(),
      });
    }

    return json(200, { ok: true, recent, locations, series });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || "Unknown error" });
  }
};
