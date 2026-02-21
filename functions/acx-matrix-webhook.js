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
    // Some runtimes support store.get(key, { type: "json" })
    const v = await store.get(key, { type: "json" });
    if (v == null) return null;
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    // Fallback: plain get + parse
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
  // Fallback: store.set string
  if (typeof store.set === "function") {
    await store.set(key, JSON.stringify(obj));
    return;
  }
  throw new Error("Blob store missing setJSON/set");
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

    // ---- LOCATION NORMALIZATION (fixes [object Object]) ----
    const locRaw =
      body.location ??
      body.location_id ??
      body.locationId ??
      body.locationID ??
      "";

    const location =
      typeof locRaw === "string"
        ? String(locRaw).trim()
        : typeof locRaw === "object" && locRaw
          ? String(
              locRaw.id ||
                locRaw.location_id ||
                locRaw.locationId ||
                locRaw._id ||
                ""
            ).trim()
          : "";

    const event = {
      ts: new Date().toISOString(),

      // identity
      account: String(body.account || body.account_name || "ACX"),
      location,

      // metrics (health pings)
      uptime: Number(body.uptime ?? 0),
      conversion: Number(body.conversion ?? 0),
      response_ms: Number(body.response_ms ?? 0),
      quotes_recovered: Number(body.quotes_recovered ?? 0),

      // IMPORTANT: prefer acx_integrity (your locked key)
      integrity: String(body.acx_integrity ?? body.integrity ?? "unknown").toLowerCase(),

      // run tracking
      run_id: String(body.run_id || `run-${Date.now()}`),

      // Phase 2 (additive; optional)
      event_name: String(body.event ?? body.event_name ?? ""),
      stage: String(body.stage ?? ""),
      priority: String(body.priority ?? ""),
      event_at: String(body.event_at ?? ""),
      contact_id: String(body.contact_id ?? ""),
    };

    if (!event.location) return json({ ok: false, error: "Missing location" }, 400);

    const key = `event:${event.location}:${Date.now()}`;

    // 1) Write event
    await writeJSON(store, key, event);

    // 2) Update global index
    const rawGlobal = await readJSON(store, "index:events");
    const globalKeys = normalizeIndex(rawGlobal);
    const nextGlobal = uniqAppend(globalKeys, key, 5000);
    await writeJSON(store, "index:events", { keys: nextGlobal });

    // 3) Update per-location index
    const locIndexKey = `index:loc:${event.location}`;
    const rawLoc = await readJSON(store, locIndexKey);
    const locKeys = normalizeIndex(rawLoc);
    const nextLoc = uniqAppend(locKeys, key, 2000);
    await writeJSON(store, locIndexKey, { keys: nextLoc });

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
