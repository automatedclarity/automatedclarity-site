// functions/acx-matrix-webhook.js
// ACX Matrix ingest endpoint (GHL + Sentinel + curl)
//
// LOCKED BEHAVIOR (no drift):
// 1) Integrity enum is ONLY: ok | degraded | critical  (NO "optimal")
//    - "optimal" is normalized to "ok"
//    - blank/unknown is treated as "missing" (does not overwrite existing summary)
// 2) Metrics overwrite protection:
//    - Only requests with header: x-acx-source: ingest (or ingest_form)
//      are allowed to WRITE metrics into per-location summary
//    - Non-ingest events still store event rows, but do NOT clobber summary metrics
// 3) EMPIRE: Integrity overwrite protection:
//    - ONLY x-acx-source: sentinel may overwrite per-location integrity
// 4) EMPIRE: No silent zeros:
//    - Missing/blank metrics are stored as null in event rows (not 0)
//    - Summary metrics only change when a value is present (non-null)
// 5) Key normalization:
//    - Promotes GHL customData[foo] and body.customData.foo to top-level foo
// 6) Location is keyed as `location` (matches summary/dashboard)

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
  const expected = (process.env.ACX_SECRET || "").trim();
  if (!expected) return false;

  const got =
    req.headers.get("x-acx-secret") ||
    req.headers.get("X-ACX-SECRET") ||
    req.headers.get("X-Acx-Secret") ||
    "";

  return !!got && String(got).trim() === expected;
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

const nowISO = () => new Date().toISOString();

// Parse numbers safely:
// - accepts "99.9", "99.9%", " 1,234 "
// - returns null if missing/invalid
const parseNumber = (v) => {
  if (v === null || v === undefined) return null;
  const s = asString(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/%/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

// Integrity enum LOCK:
// - allowed: ok, degraded, critical
// - "optimal" -> ok
// - blank/unknown/anything else -> "" (missing)
const normalizeIntegrity = (v) => {
  const s = asString(v).trim().toLowerCase();
  if (!s) return "";
  if (s === "ok") return "ok";
  if (s === "degraded") return "degraded";
  if (s === "critical") return "critical";
  if (s === "optimal") return "ok";
  if (s === "unknown") return "";
  return "";
};

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const extractLocation = (raw) => {
  if (raw && typeof raw === "object") {
    return raw.id || raw.locationId || raw.location_id || raw._id || "";
  }
  const s = asString(raw).trim();
  if (s === "[object Object]") return "";
  return s;
};

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

function getSource(req, body) {
  const h =
    req.headers.get("x-acx-source") ||
    req.headers.get("X-ACX-SOURCE") ||
    req.headers.get("X-Acx-Source") ||
    "";
  const headerSource = asString(h).trim().toLowerCase();
  const bodySource = asString(pick(body, ["source"]) || "").trim().toLowerCase();
  return headerSource || bodySource || "ghl";
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

  body = normalizeGhlCustomData(body);

  const ts = nowISO();

  const store = getStore({
    name: process.env.ACX_BLOBS_STORE || "acx-matrix",
  });

  const account =
    asString(pick(body, ["account", "acct"]) || "ACX").trim() || "ACX";

  const location = extractLocation(
    pick(body, ["location", "location_id", "locationId"])
  );

  const source = getSource(req, body);

  // Metrics overwrite protection: allow ingest + ingest_form to write summary metrics
  const allowMetricWrite = source === "ingest" || source === "ingest_form";

  // EMPIRE: only Sentinel may write integrity
  const allowIntegrityWrite = source === "sentinel";

  // Parse metrics (do NOT default to 0; null means "missing")
  const uptimeIn = parseNumber(pick(body, ["uptime"]));
  const conversionIn = parseNumber(pick(body, ["conversion", "conv"]));
  const responseMsIn = parseNumber(pick(body, ["response_ms", "resp"]));
  const quotesRecoveredIn = parseNumber(
    pick(body, ["quotes_recovered", "quotes", "quotes_recove"])
  );

  const integrityRaw = pick(body, ["acx_integrity", "integrity"]);
  const integrityNorm = normalizeIntegrity(integrityRaw); // "" means missing

  const run_id =
    asString(pick(body, ["run_id", "runId"]) || "").trim() || `run-${Date.now()}`;

  const event_name = asString(pick(body, ["event_name", "acx_event"]) || "")
    .trim()
    .toLowerCase();
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

  // ---- store event row ----
  const eventKey = `event:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

  // EMPIRE: store null for missing metrics (no fake zeros)
  const ev = {
    ts,
    account,
    location: location || "",

    uptime: uptimeIn ?? null,
    conversion: conversionIn ?? null,
    response_ms: responseMsIn ?? null,
    quotes_recovered: quotesRecoveredIn ?? null,

    integrity: integrityNorm || "unknown",
    acx_integrity: integrityNorm || "unknown",

    run_id,
    source,

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

    const locSummaryKey = `loc:${account}:${location}`;
    const prevSummary = await getJson(store, locSummaryKey, {});

    const prevIntegrity = normalizeIntegrity(prevSummary?.integrity) || "";

    // EMPIRE: only Sentinel may overwrite integrity
    const finalIntegrity = allowIntegrityWrite
      ? (integrityNorm || prevIntegrity || "")
      : (prevIntegrity || "");

    // Summary metrics: only overwrite when value is present (non-null)
    const finalUptime = allowMetricWrite
      ? (uptimeIn ?? prevSummary.uptime ?? 0)
      : (prevSummary.uptime ?? 0);

    const finalConversion = allowMetricWrite
      ? (conversionIn ?? prevSummary.conversion ?? 0)
      : (prevSummary.conversion ?? 0);

    const finalResponseMs = allowMetricWrite
      ? (responseMsIn ?? prevSummary.response_ms ?? 0)
      : (prevSummary.response_ms ?? 0);

    const finalQuotesRecovered = allowMetricWrite
      ? (quotesRecoveredIn ?? prevSummary.quotes_recovered ?? 0)
      : (prevSummary.quotes_recovered ?? 0);

    const locSummary = {
      location,
      account,
      last_seen: ts,

      uptime: finalUptime,
      conversion: finalConversion,
      response_ms: finalResponseMs,
      quotes_recovered: finalQuotesRecovered,

      integrity: finalIntegrity || "unknown",
    };

    await setJson(store, locSummaryKey, locSummary);

    // Maintain locations list for dashboard
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
    allowMetricWrite,
    source,
  });
};
