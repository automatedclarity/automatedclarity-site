// functions/acx-matrix-webhook.js
import { getStore } from "@netlify/blobs";
import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function safeString(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  try {
    return String(x);
  } catch {
    return "";
  }
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLocation(body) {
  // Accept:
  // - location: "id"
  // - location: { id: "id" }
  // - locationId
  // - location_id
  const loc =
    body?.location_id ||
    body?.locationId ||
    body?.location ||
    body?.data?.location_id ||
    body?.data?.locationId ||
    body?.data?.location;

  if (typeof loc === "string") return loc;
  if (loc && typeof loc === "object" && typeof loc.id === "string") return loc.id;
  return "";
}

function normalizeIntegrity(body) {
  // Additive: supports both acx_integrity + integrity
  const raw =
    body?.acx_integrity ||
    body?.integrity ||
    body?.data?.acx_integrity ||
    body?.data?.integrity ||
    "unknown";
  const v = safeString(raw).trim().toLowerCase();
  return v || "unknown";
}

function getContactId(body) {
  return (
    body?.contact_id ||
    body?.contactId ||
    body?.contact?.id ||
    body?.data?.contact_id ||
    body?.data?.contactId ||
    body?.data?.contact?.id ||
    ""
  );
}

function getOpportunityId(body) {
  return (
    body?.opportunity_id ||
    body?.opportunityId ||
    body?.opportunity?.id ||
    body?.data?.opportunity_id ||
    body?.data?.opportunityId ||
    body?.data?.opportunity?.id ||
    ""
  );
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
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
    if (req.method !== "POST") return methodNotAllowed();
    if (!checkAuth(req)) return unauthorized();

    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const ts = new Date().toISOString();

    // ---- REQUIRED / CORE ----
    const account = safeString(body.account || body.data?.account || "ACX");
    const location = normalizeLocation(body);

    // run_id: preserve whatever you already send; generate if missing
    const run_id = safeString(body.run_id || body.runId || body.data?.run_id || body.data?.runId || `run-${Date.now()}`);

    // ---- METRICS (existing model) ----
    const uptime = toNum(body.uptime ?? body.data?.uptime ?? 0);
    const conversion = toNum(body.conversion ?? body.data?.conversion ?? 0);
    const response_ms = toNum(body.response_ms ?? body.responseMs ?? body.data?.response_ms ?? body.data?.responseMs ?? 0);
    const quotes_recovered = toNum(body.quotes_recovered ?? body.quotesRecovered ?? body.data?.quotes_recovered ?? body.data?.quotesRecovered ?? 0);

    // ---- INTEGRITY (additive support) ----
    const integrity = normalizeIntegrity(body);

    // ---- LEGACY WORKFLOW KEYS (preserve) ----
    const event_name = safeString(body.event_name || body.eventName || body.data?.event_name || body.data?.eventName || "");
    const stage = safeString(body.stage || body.data?.stage || "");
    const priority = safeString(body.priority || body.data?.priority || "");
    const event_at = safeString(body.event_at || body.eventAt || body.data?.event_at || body.data?.eventAt || "");

    // ---- PHASE 2 KEYS (additive) ----
    const acx_event = safeString(body.acx_event || body.data?.acx_event || "");
    const acx_stage = safeString(body.acx_stage || body.data?.acx_stage || "");
    const acx_status = safeString(body.acx_status || body.data?.acx_status || "");

    const contact_id = safeString(getContactId(body));
    const opportunity_id = safeString(getOpportunityId(body));

    // Optional: preserve caller-provided source if present; fallback to "ghl"
    const source = safeString(body.source || body.data?.source || "ghl");

    // ---- BUILD EVENT OBJECT (additive, no breaking changes) ----
    const ev = {
      ts,
      account,
      location, // normalized (prevents "[object Object]")
      uptime,
      conversion,
      response_ms,
      quotes_recovered,

      // keep legacy key for current UI + summary
      integrity,

      // additive new key (Phase 2)
      acx_integrity: integrity,

      run_id,
      source,

      // legacy workflow keys (keep)
      event_name,
      stage,
      priority,
      event_at,

      // Phase 2 workflow keys (new)
      acx_event,
      acx_stage,
      acx_status,

      // ids (helpful for telemetry + recovery math)
      contact_id,
      opportunity_id,
    };

    // ---- WRITE TO BLOBS STORE ----
    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // event key: stable + unique; keep newest-last index behavior your summary expects
    const key = `event:${Date.now()}:${randomId()}`;
    await store.set(key, JSON.stringify(ev));

    // Update index:events (newest last)
    const idxRaw = await readJSON(store, "index:events");
    const keys = normalizeIndex(idxRaw);
    keys.push(key);

    // Optional cap (safety): keeps index from growing forever.
    // Additive: does not delete old event blobs; just caps index list.
    const maxIndex = Number(process.env.ACX_MATRIX_MAX_INDEX || 5000);
    const trimmed = keys.length > maxIndex ? keys.slice(keys.length - maxIndex) : keys;

    await store.set("index:events", JSON.stringify(trimmed));

    return json(200, { ok: true, stored: true, key, store: storeName });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || "Unknown error" });
  }
};
