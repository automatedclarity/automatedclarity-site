// functions/acx-matrix-ingest-integrity.js
// Secret-auth ingest for Sentinel -> Matrix (writes an event)

import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function authOk(req) {
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  const got = (req.headers.get("x-acx-secret") || "").trim();
  return !!expected && got === expected;
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

async function readJSON(store, key) {
  try {
    const v = await store.get(key, { type: "json" });
    if (v == null) return null;
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    try {
      const s = await store.get(key);
      if (s == null) return null;
      if (typeof s === "string") return JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  }
}

function normalizeIndex(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object" && Array.isArray(raw.keys)) return raw.keys.map(String).filter(Boolean);
  return [];
}

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ ok:false, error:"Method Not Allowed" }, 405);
    if (!authOk(req)) return json({ ok:false, error:"Unauthorized" }, 401);

    const body = await readBody(req);

    // required minimal inputs
    const location = String(body.location || body.location_id || "").trim();
    const account = String(body.account || "ACX").trim();
    const integrity = String(body.integrity || "").trim().toLowerCase();

    if (!location) return json({ ok:false, error:"Missing location" }, 400);
    if (!["critical","degraded","optimal","unknown"].includes(integrity)) {
      return json({ ok:false, error:"Invalid integrity" }, 400);
    }

    const ts = body.ts ? String(body.ts) : new Date().toISOString();
    const run_id = String(body.run_id || `run_SENTINEL_${integrity.toUpperCase()}_${Date.now()}`);

    // optional metrics (safe defaults)
    const uptime = Number(body.uptime ?? 0);
    const conversion = Number(body.conversion ?? 0);
    const response_ms = Number(body.response_ms ?? 0);
    const quotes_recovered = Number(body.quotes_recovered ?? 0);

    const event = {
      ts,
      run_id,
      account,
      location,
      uptime: Number.isFinite(uptime) ? uptime : 0,
      conversion: Number.isFinite(conversion) ? conversion : 0,
      response_ms: Number.isFinite(response_ms) ? response_ms : 0,
      quotes_recovered: Number.isFinite(quotes_recovered) ? quotes_recovered : 0,
      integrity,
      source: "sentinel",
    };

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const key = `event:${ts}:${run_id}`;

    // write event
    await store.set(key, JSON.stringify(event), {
      metadata: { ts, run_id, location, integrity, source: "sentinel" },
    });

    // update index:events
    const idxRaw = await readJSON(store, "index:events");
    const keys = normalizeIndex(idxRaw);

    // append newest
    keys.push(key);

    // keep index bounded
    const max = 5000;
    const trimmed = keys.length > max ? keys.slice(keys.length - max) : keys;

    await store.set("index:events", JSON.stringify(trimmed));

    return json({ ok:true, key, store: storeName });

  } catch (e) {
    return json({ ok:false, error:e?.message || "error" }, 500);
  }
};
