// functions/acx-matrix-webhook.js
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

function normalizeIndex(raw) {
  // Accept:
  // - ["k1","k2"]
  // - { keys: ["k1","k2"] }
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
  // remove existing key if present
  const idx = out.indexOf(key);
  if (idx >= 0) out.splice(idx, 1);
  out.push(key);
  // trim oldest
  if (out.length > max) out.splice(0, out.length - max);
  return out;
}

export default async (req) => {
  try {
    if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
    if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Bad JSON" }, 400);
    }

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const event = {
      ts: new Date().toISOString(),
      account: String(body.account || body.account_name || "ACX"),
      location: String(body.location || body.location_id || ""),
      uptime: Number(body.uptime ?? 0),
      conversion: Number(body.conversion ?? 0),
      response_ms: Number(body.response_ms ?? 0),
      quotes_recovered: Number(body.quotes_recovered ?? 0),
      integrity: String((body.integrity || "unknown")).toLowerCase(),
      run_id: String(body.run_id || `run-${Date.now()}`),
    };

    if (!event.location) {
      return json({ ok: false, error: "Missing location" }, 400);
    }

    const key = `event:${event.location}:${Date.now()}`;

    // 1) Write the event blob
    await store.setJSON(key, event);

    // 2) Update global index
    const rawGlobal = await store.getJSON("index:events").catch(() => null);
    const globalKeys = normalizeIndex(rawGlobal);
    const nextGlobal = uniqAppend(globalKeys, key, 5000);
    await store.setJSON("index:events", { keys: nextGlobal });

    // 3) Update per-location index (optional but useful)
    const locIndexKey = `index:loc:${event.location}`;
    const rawLoc = await store.getJSON(locIndexKey).catch(() => null);
    const locKeys = normalizeIndex(rawLoc);
    const nextLoc = uniqAppend(locKeys, key, 2000);
    await store.setJSON(locIndexKey, { keys: nextLoc });

    return json({
      ok: true,
      stored: { key, store: storeName },
      index: { global_count: nextGlobal.length, loc_count: nextLoc.length },
      event,
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
