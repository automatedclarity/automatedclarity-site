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

function pick(body, keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return undefined;
}

function normStr(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim().toLowerCase();
  // if GHL sends an object/array by accident, stringify safely
  try {
    return JSON.stringify(v).trim().toLowerCase();
  } catch {
    return String(v).trim().toLowerCase();
  }
}

function mapIntegrity(raw, failStreakNum = 0) {
  // If fail streak provided, it wins
  if (Number.isFinite(failStreakNum) && failStreakNum >= 3) return "critical";
  if (Number.isFinite(failStreakNum) && failStreakNum > 0) return "degraded";

  const s = normStr(raw);

  const CRIT = new Set(["critical", "crit", "fail", "failed", "down", "error", "unhealthy", "red"]);
  const DEG  = new Set(["degraded", "warn", "warning", "unstable", "yellow"]);
  const OPT  = new Set(["optimal", "ok", "healthy", "up", "green"]);

  if (CRIT.has(s)) return "critical";
  if (DEG.has(s)) return "degraded";
  if (OPT.has(s)) return "optimal";
  if (s === "unknown" || s === "") return "unknown";
  return "unknown";
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
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

    // Support BOTH keys so GHL standard data can’t wreck us
    const location = String(
      pick(body, ["location", "location_id", "locationId"]) ||
      pick(body?.contact, ["locationId"]) ||
      ""
    ).trim();

    if (!location) return json({ ok: false, error: "Missing location" }, 400);

    const failStreak = toNum(pick(body, ["fail_streak", "failStreak", "streak"]), NaN);

    const integrityRaw = pick(body, ["acx_integrity", "integrity"]);
    const integrity = mapIntegrity(integrityRaw, failStreak);

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const event = {
      ts: new Date().toISOString(),
      account: String(pick(body, ["account", "account_name"]) || "ACX"),
      location,
      uptime: toNum(pick(body, ["uptime"]), 0),
      conversion: toNum(pick(body, ["conversion"]), 0),
      response_ms: toNum(pick(body, ["response_ms"]), 0),
      quotes_recovered: toNum(pick(body, ["quotes_recovered"]), 0),
      integrity,
      run_id: String(pick(body, ["run_id", "runId"]) || `run-${Date.now()}`),
      source: "ghl",
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
      stored: { key, store: storeName },
      index: { global_count: nextGlobal.length, loc_count: nextLoc.length },
      event,
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
