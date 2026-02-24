// netlify/functions/acx-matrix-recent.js
// Returns recent ACX Matrix ingests (same source of truth as acx-matrix-webhook)
// Output shape: { runs: [...] } for compatibility with current console UI

import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });

function normalizeIndex(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object") {
    if (Array.isArray(raw.keys)) return raw.keys.map(String).filter(Boolean);
    if (Array.isArray(raw.items)) return raw.items.map(String).filter(Boolean);
  }
  return [];
}

async function readJSON(store, key, fallback = null) {
  try {
    const v = await store.get(key, { type: "json" });
    if (v === null || v === undefined) return fallback;
    return v;
  } catch {
    try {
      const s = await store.get(key);
      if (s === null || s === undefined) return fallback;
      if (typeof s === "string") return JSON.parse(s);
      return s;
    } catch {
      return fallback;
    }
  }
}

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export default async (req) => {
  if (req.method !== "GET") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Number(limitParam || 50), 200);

  const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
  const store = getStore({ name: storeName });

  // NEW schema index
  let keys = normalizeIndex(await readJSON(store, "index:global", null));

  // fallback OLD schema index
  if (!keys.length) {
    keys = normalizeIndex(await readJSON(store, "index:events", null));
  }

  // Pull newest first
  const runs = [];
  for (const k of keys.slice(0, limit)) {
    const ev = await readJSON(store, k, null);
    if (!ev) continue;

    const integrity = String(ev.integrity || ev.acx_integrity || "unknown").toLowerCase();

    // Map Matrix event -> “run” object (console expects created_at)
    runs.push({
      created_at: ev.ts || "",
      account: String(ev.account || "ACX"),
      location: String(ev.location || ""),
      run_id: String(ev.run_id || ""),

      // keep the UI’s existing expectations without changing UI code
      sentinel: { status: integrity },

      // expose Matrix metrics
      matrix: {
        integrity,
        uptime: num(ev.uptime, 0),
        conversion: num(ev.conversion, 0),
        response_ms: num(ev.response_ms, 0),
        quotes_recovered: num(ev.quotes_recovered, 0),
      },

      // optional passthrough
      source: String(ev.source || ""),
      key: String(k),
    });
  }

  return json({ runs }, 200);
};
