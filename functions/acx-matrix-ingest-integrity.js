// functions/acx-matrix-ingest-integrity.js
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

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Handle GHL “standard data” where location might come as object
function coerceLocationId(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // common shapes: {id:"..."}, {locationId:"..."}, etc.
    const maybe =
      v.id || v.location_id || v.locationId || v._id || v.value || "";
    return String(maybe || "").trim();
  }
  return String(v).trim();
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

    // ✅ Accept both keys, prefer explicit "integrity"
    const integrityRaw = pickFirst(body, ["integrity", "acx_integrity"]);

    const integrity = String(integrityRaw || "unknown").toLowerCase().trim();

    // ✅ Accept location OR location_id OR locationId and handle object
    const location = coerceLocationId(
      pickFirst(body, ["location", "location_id", "locationId"])
    );

    const account = String(pickFirst(body, ["account", "account_name"]) || "ACX");
    const run_id = String(pickFirst(body, ["run_id", "runId"]) || `run-${Date.now()}`);

    const allowed = new Set(["critical", "degraded", "optimal", "unknown"]);
    if (!allowed.has(integrity)) {
      return json(
        {
          ok: false,
          error: "Invalid integrity",
          received: { integrityRaw, integrity, location: typeof body.location },
          hint: 'Send integrity as "critical|degraded|optimal" (or use acx_integrity).',
        },
        400
      );
    }

    if (!location) return json({ ok: false, error: "Missing location" }, 400);

    const event = {
      ts: new Date().toISOString(),
      account,
      location,
      uptime: Number(body.uptime ?? 0),
      conversion: Number(body.conversion ?? 0),
      response_ms: Number(body.response_ms ?? 0),
      quotes_recovered: Number(body.quotes_recovered ?? 0),
      integrity,
      run_id,
      source: String(pickFirst(body, ["source"]) || "sentinel"),
    };

    const key = `event:${location}:${Date.now()}`;

    // 1) Write event
    await writeJSON(store, key, event);

    // 2) Update global index
    const rawGlobal = await readJSON(store, "index:events");
    const globalKeys = normalizeIndex(rawGlobal);
    const nextGlobal = uniqAppend(globalKeys, key, 5000);
    await writeJSON(store, "index:events", { keys: nextGlobal });

    // 3) Update per-location index
    const locIndexKey = `index:loc:${location}`;
    const rawLoc = await readJSON(store, locIndexKey);
    const locKeys = normalizeIndex(rawLoc);
    const nextLoc = uniqAppend(locKeys, key, 2000);
    await writeJSON(store, locIndexKey, { keys: nextLoc });

    return json({
      ok: true,
      key,
      store: storeName,
      event,
      index: { global_count: nextGlobal.length, loc_count: nextLoc.length },
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
