// functions/acx-matrix-summary.js
// ✅ Dual-auth (NO session.js changes):
// - Browser dashboard still uses requireSession(cookie)
// - CLI/automation can use x-acx-secret header (same as webhook)
//
// ✅ Fixes (LOCKED):
// - Integrity enum ONLY: ok | degraded | critical | unknown (no "optimal")
// - Locations tiles are read from webhook-maintained summaries (NOT inferred from recent events)
//   → prevents WF3/telemetry/limit from zeroing tiles
// - Recent table is METRICS ONLY (prevents WF webhooks with zeros from polluting)
// - Location normalized so you never get "[object Object]"
// - Supports metrics in top-level OR inside data:{...}
//
// ✅ CRITICAL FIX:
// - Netlify req.url is often RELATIVE → new URL(req.url) THROWS → lambda returns invalid response
//   → use new URL(req.url, "https://console.automatedclarity.com")

import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// ---------------- helpers ----------------
function normalizeIndex(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "object" && Array.isArray(raw.keys))
    return raw.keys.map(String).filter(Boolean);
  return [];
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

function toNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function getField(e, key) {
  return e?.[key] ?? e?.data?.[key] ?? null;
}

function getLocationValue(ev) {
  const v =
    ev?.location ??
    ev?.data?.location ??
    ev?.location_id ??
    ev?.data?.location_id ??
    ev?.locationId ??
    ev?.data?.locationId ??
    ev?.contact?.locationId ??
    ev?.data?.contact?.locationId ??
    "";

  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (v.id) return String(v.id);
    if (v.locationId) return String(v.locationId);
    return "";
  }
  return "";
}

// LOCKED integrity enum: ok | degraded | critical | unknown
function normalizeIntegrity(raw) {
  const v = String(raw || "unknown").toLowerCase().trim();
  if (!v) return "unknown";
  if (v === "ok") return "ok";
  if (v === "degraded" || v === "warn" || v === "warning") return "degraded";
  if (v === "critical" || v === "crit" || v === "down") return "critical";
  return "unknown";
}

function getIntegrity(ev) {
  return normalizeIntegrity(
    ev?.acx_integrity ??
      ev?.integrity ??
      ev?.data?.acx_integrity ??
      ev?.data?.integrity ??
      "unknown"
  );
}

function getMetric(ev, key) {
  const v = getField(ev, key);
  return toNum(v, 0);
}

function hasMetrics(ev) {
  const u = getMetric(ev, "uptime");
  const c = getMetric(ev, "conversion");
  const r = getMetric(ev, "response_ms");
  const q = getMetric(ev, "quotes_recovered");
  return [u, c, r, q].some((n) => Number.isFinite(n) && n !== 0);
}

function isWorkflowEvent(ev) {
  return !!(
    getField(ev, "event_name") ||
    getField(ev, "stage") ||
    getField(ev, "priority") ||
    getField(ev, "acx_event") ||
    getField(ev, "acx_stage") ||
    getField(ev, "acx_status")
  );
}

function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const k of arr) {
    const s = String(k || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function sortEventKeysAscending(keys) {
  const parse = (k) => {
    const m = /^event:(\d+):/.exec(k);
    return m ? Number(m[1]) : null;
  };
  return keys.slice().sort((a, b) => {
    const ta = parse(a);
    const tb = parse(b);
    if (ta == null && tb == null) return 0;
    if (ta == null) return -1;
    if (tb == null) return 1;
    return ta - tb;
  });
}

// ---------------- AUTH (cookie session OR x-acx-secret) ----------------
function header(req, name) {
  try {
    return req.headers.get(name);
  } catch {
    return null;
  }
}

// LOCKED: single secret source of truth (no env drift)
function secretAllowed(req) {
  const got = header(req, "x-acx-secret");
  const expected = process.env.ACX_SECRET;
  return !!got && !!expected && String(got) === String(expected);
}

async function enforceAuth(req) {
  // 1) cookie session path
  // requireSession typically returns a Response (redirect) when NOT authed,
  // and returns null/void when authed. Respect that.
  try {
    const maybe = await requireSession(req);
    if (maybe instanceof Response) return maybe; // redirect or deny response
    // if it returned nothing, session is OK
    return null;
  } catch {
    // fall through to secret path
  }

  // 2) secret header path
  if (secretAllowed(req)) return null;

  return json({ ok: false, error: "Unauthorized" }, 401);
}

// ---------------- main ----------------
export default async (req) => {
  try {
    if (req.method !== "GET")
      return json({ ok: false, error: "Method Not Allowed" }, 405);

    const deny = await enforceAuth(req);
    if (deny) return deny;

    // ✅ Netlify req.url is often RELATIVE → must provide a base
    const url = new URL(req.url, "https://console.automatedclarity.com");

    const limit = Math.max(
      1,
      Math.min(500, Number(url.searchParams.get("limit") || 50))
    );

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // Allow account override, default ACX
    const accountParam =
      String(url.searchParams.get("account") || "ACX").trim() || "ACX";

    // ---------- LOCATIONS (SOURCE OF TRUTH) ----------
    let locations = (await readJSON(store, `locations:${accountParam}`)) || [];
    if (!Array.isArray(locations)) locations = [];

    locations = locations
      .filter((r) => r && r.location)
      .map((r) => ({
        location: String(r.location || ""),
        account: String(r.account || accountParam),
        last_seen: String(r.last_seen || ""),
        uptime: Number(r.uptime || 0),
        conversion: Number(r.conversion || 0),
        response_ms: Number(r.response_ms || 0),
        quotes_recovered: Number(r.quotes_recovered || 0),
        integrity: normalizeIntegrity(r.integrity),
      }));

    // ---------- EVENTS (RECENT TABLE + SERIES) ----------
    const idxEventsRaw = await readJSON(store, "index:events");
    const idxGlobalRaw = await readJSON(store, "index:global");

    const idxEvents = normalizeIndex(idxEventsRaw);
    const idxGlobal = normalizeIndex(idxGlobalRaw);

    let keys = dedupeKeepOrder([...idxEvents, ...idxGlobal]);
    keys = sortEventKeysAscending(keys);

    const index_count = keys.length;

    // tail (newest events)
    const tailKeys = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const allEvents = [];
    for (const k of tailKeys) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") allEvents.push(ev);
    }

    const normalizedAll = allEvents.map((e) => ({
      ...e,
      location: getLocationValue(e),
      integrity: getIntegrity(e),
      acx_integrity: getIntegrity(e),
      uptime: getMetric(e, "uptime"),
      conversion: getMetric(e, "conversion"),
      response_ms: getMetric(e, "response_ms"),
      quotes_recovered: getMetric(e, "quotes_recovered"),
    }));

    // ✅ Recent rows: metrics-only and not workflow telemetry
    const recent = normalizedAll.filter((e) => hasMetrics(e) && !isWorkflowEvent(e));

    // ✅ Series: metrics-only
    const series = {};
    for (const ev of recent.slice().reverse()) {
      const loc = getLocationValue(ev);
      if (!loc) continue;
      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: ev.ts,
        uptime: Number(ev.uptime || 0),
        conv: Number(ev.conversion || 0),
        resp: Number(ev.response_ms || 0),
        quotes: Number(ev.quotes_recovered || 0),
        integrity: getIntegrity(ev),
      });
    }

    return json({
      ok: true,
      recent,
      locations,
      series,
      meta: { store: storeName, index_count },
    });
  } catch (e) {
    // IMPORTANT: always return JSON, never crash the lambda response
    return json(
      { ok: false, error: e?.message || "Unknown error", where: "acx-matrix-summary" },
      500
    );
  }
};
