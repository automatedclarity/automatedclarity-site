// functions/acx-matrix-ingest-integrity.js
// Secret-auth ingest for Sentinel -> Matrix (writes an event + updates canonical index:events)

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

function normalizeIndex(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object") {
    if (Array.isArray(raw.keys)) return raw.keys.map(String).filter(Boolean);
    if (Array.isArray(raw.items)) return raw.items.map(String).filter(Boolean);
  }
  return [];
}

function uniqAppend(list, key, max = 5000) {
  const out = Array.isArray(list) ? list.slice() : [];
  const i = out.indexOf(key);
  if (i >= 0) out.splice(i, 1);
  out.push(key);
  if (out.length > max) out.splice(0, out.length - max);
  return out;
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

async function writeJSON(store, key, obj) {
  if (typeof store.setJSON === "function") {
    await store.setJSON(key, obj);
    return;
  }
  if (typeof store.set === "function") {
    await store.set(key, JSON.stringify(obj));
    return;
  }
  throw new Error("Blob store missing setJSON/set");
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ ok:false, error:"Method Not Allowed" }, 405);
    if (!authOk(req)) return json({ ok:false, error:"Unauthorized" }, 401);

    const body = await readBody(req);

    const location = String(body.location || body.location_id || "").trim();
    const account = String(body.account || "ACX").trim();
    const integrity = String(body.integrity || "").trim().toLowerCase();

    if (!location) return json({ ok:false, error:"Missing location" }, 400);
    if (!["critical","degraded","optimal","unknown"].includes(integrity)) {
      return json({ ok:false, error:"Invalid integrity" }, 400);
    }

    const ts = body.ts ? String(body.ts) : new Date().toISOString();
    const run_id = String(body.run_id || `run_SENTINEL_${integrity.toUpperCase()}_${Date.now()}`);

    const event = {
      ts,
      run_id,
      account,
      location,
      uptime: toNum(body.uptime, 0),
      conversion: toNum(body.conversion, 0),
      response_ms: toNum(body.response_ms, 0),
      quotes_recovered: toNum(body.quotes_recovered, 0),
      integrity,
      source: "sentinel",
    };

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // match webhook key style (location + millis) so it’s consistent
    const key = `event:${location}:${Date.now()}`;

    // 1) write event
    await writeJSON(store, key, event);

    // 2) update canonical global index
    const rawGlobal = await readJSON(store, "index:events");
    const globalKeys = normalizeIndex(rawGlobal);
    const nextGlobal = uniqAppend(globalKeys, key, 5000);
    await writeJSON(store, "index:events", { keys: nextGlobal });

    // 3) update per-location index
    const locIndexKey = `index:loc:${location}`;
    const rawLoc = await readJSON(store, locIndexKey);
    const locKeys = normalizeIndex(rawLoc);
    const nextLoc = uniqAppend(locKeys, key, 2000);
    await writeJSON(store, locIndexKey, { keys: nextLoc });

    return json({ ok:true, key, store: storeName, event });

  } catch (e) {
    return json({ ok:false, error:e?.message || "error" }, 500);
  }
};
