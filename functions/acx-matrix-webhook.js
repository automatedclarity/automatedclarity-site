// netlify/functions/acx-matrix-webhook.js
// ACX Matrix ingest endpoint (GHL + Sentinel + curl)
// - Stores each event row
// - Maintains per-location summary (last_seen + metrics + integrity)
// - Preserves integrity when incoming event has missing/unknown integrity
// - Fixes location "[object Object]" by extracting .id when location is an object
// - FIX: Normalizes GHL customData[foo] keys so you do NOT need to change webhook fields
// - FIX: Single auth source of truth: ACX_SECRET (no ACX_WEBHOOK_SECRET drift)

import { getStore } from "@netlify/blobs";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });

const methodNotAllowed = () =>
  json(405, { ok: false, error: "Method Not Allowed" });
const unauthorized = () => json(401, { ok: false, error: "Unauthorized" });

const checkAuth = (req) => {
  const expected = process.env.ACX_SECRET || "";
  if (!expected) return false;

  const got =
    req.headers.get("x-acx-secret") ||
    req.headers.get("X-ACX-SECRET") ||
    req.headers.get("X-Acx-Secret") ||
    "";

  return !!got && got === expected;
};

// ---------- helpers ----------
const asString = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const asNumber = (v, fallback = 0) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const normIntegrity = (v) => {
  const s = asString(v).trim().toLowerCase();
  if (!s) return "";
  if (s === "critical") return "critical";
  if (s === "degraded") return "degraded";
  if (s === "optimal") return "optimal";
  if (s === "unknown") return "unknown";
  return "unknown";
};

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const extractLocation = (raw) => {
  // If GHL sends location object, extract ID
  if (raw && typeof raw === "object") {
    return raw.id || raw.locationId || raw.location_id || raw._id || "";
  }
  const s = asString(raw).trim();
  // if it is literally "[object Object]" return empty to avoid polluting summaries
  if (s === "[object Object]") return "";
  return s;
};

const nowISO = () => new Date().toISOString();

async function getJson(store, key, fallback = {}) {
  try {
    const raw = await store.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function setJson(store, key, obj) {
  await store.set(key, JSON.stringify(obj));
}

// Keep small rolling indexes so dashboard stays fast
const MAX_GLOBAL_INDEX = 1000;
const MAX_LOC_INDEX = 1000;

function pushIndex(arr, item, maxLen) {
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.unshift(item); // newest first
  if (next.length > maxLen) next.length = maxLen;
  return next;
}

// Normalize GHL "customData[foo]" payload keys into top-level keys
function normalizeGhlCustomData(body) {
  if (!body || typeof body !== "object") return body;

  // 1) Promote customData[foo] -> foo
  for (const [k, v] of Object.entries(body)) {
    const m = /^customData\[(.+?)\]$/.exec(k);
    if (m && m[1]) {
      const key = m[1].trim();
      if (key && body[key] === undefined) body[key] = v;
    }
  }

  // 2) Merge body.customData (if present) -> top-level
  if (body.customData && typeof body.customData === "object") {
    for (const [k, v] of Object.entries(body.customData)) {
      if (body[k] === undefined) body[k] = v;
    }
  }

  return body;
}

// ---------- main ----------
export default async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // IMPORTANT: normalize GHL customData[foo] keys
  body = normalizeGhlCustomData(body);

  // ---- parse incoming ----
  const account =
    asString(pick(body, ["account", "acct"]) || "ACX").trim() || "ACX";

  const location = extractLocation(
    pick(body, ["location", "location_id", "locationId"])
  );

  // metrics (optional)
  const uptime = asNumber(pick(body, ["uptime"]), 0);
  const conversion = asNumber(pick(body, ["conversion", "conv"]), 0);
  const response_ms = asNumber(pick(body, ["response_ms", "resp"]), 0);
  const quotes_recovered = asNumber(
    pick(body, ["quotes_recovered", "quotes"]),
    0
  );

  // integrity can come in multiple keys
  const integrityRaw = pick(body, ["acx_integrity", "integrity"]);
  const integrity = normIntegrity(integrityRaw) || "unknown";

  // telemetry extras (optional)
  const run_id =
    asString(pick(body, ["run_id", "runId"]) || "").trim() ||
    `run-${Date.now()}`;

  const event_name = asString(pick(body, ["event_name", "acx_event"]) || "")
    .trim()
    .toLowerCase(); // store consistently
  const stage = asString(pick(body, ["stage", "acx_stage"]) || "")
    .trim()
    .toLowerCase();
  const priority = asString(pick(body, ["priority"]) || "")
    .trim()
    .toLowerCase();
  const event_at = asString(pick(body, ["event_at"]) || "").trim();

  const contact_id = asString(pick(body, ["contact_id", "contactId"]) || "")
    .trim()
    .toString();
  const opportunity_id = asString(
    pick(body, ["opportunity_id", "opportunityId"]) || ""
  )
    .trim()
    .toString();

  // If location is missing, still store the event but don’t update per-location summary
  const ts = nowISO();

  // ✅ FIX: use the same blob store selection logic as summary
  const store = getStore({
    name: process.env.ACX_BLOBS_STORE || "acx-matrix",
  });

  // ---- store event row ----
  const eventKey = `event:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const ev = {
    ts,
    account,
    location: location || "",
    uptime,
    conversion,
    response_ms,
    quotes_recovered,
    integrity, // normalized
    acx_integrity: integrity, // parity/debug
    run_id,
    source: asString(pick(body, ["source"]) || "ghl"),

    // optional telemetry
    event_name,
    stage,
    priority,
    event_at,
    contact_id,
    opportunity_id,
  };

  await setJson(store, eventKey, ev);

  // ---- update global index ----
  const globalIndexKey = `index:global`;
  const globalIndex = await getJson(store, globalIndexKey, []);
  const nextGlobalIndex = pushIndex(globalIndex, eventKey, MAX_GLOBAL_INDEX);
  await setJson(store, globalIndexKey, nextGlobalIndex);

  // ---- update per-location index + summary ----
  if (location) {
    const locIndexKey = `index:loc:${account}:${location}`;
    const locIndex = await getJson(store, locIndexKey, []);
    const nextLocIndex = pushIndex(locIndex, eventKey, MAX_LOC_INDEX);
    await setJson(store, locIndexKey, nextLocIndex);

    // SUMMARY KEY FIX:
    // - read previous summary
    // - only overwrite integrity if new integrity is not missing/unknown
    const locSummaryKey = `loc:${account}:${location}`;
    const prevSummary = await getJson(store, locSummaryKey, {});

    const prevIntegrity = normIntegrity(prevSummary?.integrity) || "unknown";
    const newIntegrity = normIntegrity(integrity) || "unknown";

    const finalIntegrity =
      newIntegrity && newIntegrity !== "unknown"
        ? newIntegrity
        : prevIntegrity || "unknown";

    // IMPORTANT: preserve prior metrics if incoming is 0/blank
    const locSummary = {
      location,
      account,
      last_seen: ts,

      uptime: uptime || prevSummary.uptime || 0,
      conversion: conversion || prevSummary.conversion || 0,
      response_ms: response_ms || prevSummary.response_ms || 0,
      quotes_recovered: quotes_recovered || prevSummary.quotes_recovered || 0,

      integrity: finalIntegrity,
    };

    await setJson(store, locSummaryKey, locSummary);

    // Maintain a simple locations list for the dashboard
    const locListKey = `locations:${account}`;
    const locList = await getJson(store, locListKey, []);
    const nextLocList = Array.isArray(locList) ? locList.filter(Boolean) : [];

    const item = {
      location,
      account,
      last_seen: ts,
      uptime: locSummary.uptime,
      conversion: locSummary.conversion,
      response_ms: locSummary.response_ms,
      quotes_recovered: locSummary.quotes_recovered,
      integrity: locSummary.integrity,
    };

    // replace existing or add new
    let replaced = false;
    for (let i = 0; i < nextLocList.length; i++) {
      if (
        nextLocList[i]?.account === account &&
        nextLocList[i]?.location === location
      ) {
        nextLocList[i] = item;
        replaced = true;
      }
    }
    if (!replaced) nextLocList.unshift(item);

    // Deduplicate
    const seen = new Set();
    const deduped = [];
    for (const r of nextLocList) {
      const k = `${r.account}:${r.location}`;
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push(r);
      }
    }

    await setJson(store, locListKey, deduped);
  }

  return json(200, {
    ok: true,
    stored: true,
    key: eventKey,
    store: process.env.ACX_BLOBS_STORE || "acx-matrix",
  });
};
