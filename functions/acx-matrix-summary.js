// functions/acx-matrix-summary.js
// ✅ Dual-auth (NO session.js changes):
// - Browser dashboard still uses requireSession(cookie)
// - CLI/automation can use x-acx-secret header (same as webhook)
//
// ✅ Fixes:
// - "optimal" is normalized to "ok"
// - recent table returns METRICS events only (prevents WF webhooks with zeros from polluting)
// - location is normalized so you never get "[object Object]"
// - supports metrics coming in at top-level OR inside data:{...}

import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

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

// Normalize integrity to ONLY: ok | degraded | critical | unknown
function normalizeIntegrity(raw) {
  const v = String(raw || "unknown").toLowerCase().trim();
  if (!v) return "unknown";
  if (v === "optimal") return "ok";
  if (v === "green") return "ok";
  if (v === "good") return "ok";
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

// Metrics can be in top-level OR inside data:{...}
function getMetric(ev, key) {
  const v = getField(ev, key);
  return toNum(v, 0);
}

// Treat as a metrics/health payload if it has any numeric signal
function hasMetrics(ev) {
  const u = getMetric(ev, "uptime");
  const c = getMetric(ev, "conversion");
  const r = getMetric(ev, "response_ms");
  const q = getMetric(ev, "quotes_recovered");
  return [u, c, r, q].some((n) => Number.isFinite(n) && n !== 0);
}

// Workflow/telemetry marker keys (so we can keep them OUT of metrics tiles)
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

// --- AUTH (cookie session OR x-acx-secret) ---
function header(req, name) {
  try {
    return req.headers.get(name);
  } catch {
    return null;
  }
}

function secretAllowed(req) {
  const got = header(req, "x-acx-secret");
  if (!got) return false;

  // Accept any of these env names (so we don't drift your env naming)
  const candidates = [
    process.env.ACX_SECRET,
    process.env.ACX_WEBHOOK_SECRET,
    process.env.ACX_MATRIX_SECRET,
    process.env.ACX_SHARED_SECRET,
    process.env.X_ACX_SECRET,
  ].filter(Boolean);

  if (!candidates.length) return false;
  return candidates.some((s) => String(s) === String(got));
}

// Keep session login for the browser, but allow x-acx-secret for curl
async function enforceAuth(req) {
  // 1) cookie session path
  try {
    const res = await requireSession(req);
    // support both patterns:
    // - throws on fail
    // - returns { ok, response }
    if (res && typeof res === "object" && "ok" in res) {
      if (res.ok) return null;
      // if session failed, fall through to secret check
    } else {
      // session ok
      return null;
    }
  } catch {
    // session failed, fall through to secret check
  }

  // 2) secret header path
  if (secretAllowed(req)) return null;

  return json({ ok: false, error: "Unauthorized" }, 401);
}

export default async (req) => {
  try {
    if (req.method !== "GET")
      return json({ ok: false, error: "Method Not Allowed" }, 405);

    const deny = await enforceAuth(req);
    if (deny) return deny;

    const url = new URL(req.url);
    const limit = Math.max(
      1,
      Math.min(500, Number(url.searchParams.get("limit") || 50))
    );

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // Merge both indexes (legacy-safe)
    const idxEventsRaw = await readJSON(store, "index:events");
    const idxGlobalRaw = await readJSON(store, "index:global");

    const idxEvents = normalizeIndex(idxEventsRaw);
    const idxGlobal = normalizeIndex(idxGlobalRaw);

    let keys = dedupeKeepOrder([...idxEvents, ...idxGlobal]);
    keys = sortEventKeysAscending(keys);

    const index_count = keys.length;

    // Pull tail (newest events)
    const tailKeys = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const allEvents = [];
    for (const k of tailKeys) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") allEvents.push(ev);
    }

    // Normalize events so UI never sees location as object, and integrity is normalized
    const normalizedAll = allEvents.map((e) => ({
      ...e,
      location: getLocationValue(e),
      integrity: getIntegrity(e),
      acx_integrity: getIntegrity(e), // keep both for safety
      uptime: getMetric(e, "uptime"),
      conversion: getMetric(e, "conversion"),
      response_ms: getMetric(e, "response_ms"),
      quotes_recovered: getMetric(e, "quotes_recovered"),
    }));

    // ✅ Recent table should be METRICS ONLY (prevents workflow webhooks from showing 0/unknown)
    const recent = normalizedAll.filter((e) => hasMetrics(e) && !isWorkflowEvent(e));

    // Locations summary:
    // - last_seen + integrity come from newest event of ANY type
    // - metrics come from newest METRICS event (so workflow events can't zero tiles)
    const locState = new Map();

    for (const ev of normalizedAll) {
      const loc = getLocationValue(ev);
      if (!loc) continue;

      if (!locState.has(loc)) {
        locState.set(loc, {
          latestAny: ev, // newest-first
          latestMetrics: null,
        });
      }

      const st = locState.get(loc);
      if (!st.latestMetrics && hasMetrics(ev) && !isWorkflowEvent(ev)) {
        st.latestMetrics = ev;
      }
    }

    const locations = Array.from(locState.entries()).map(([loc, st]) => {
      const any = st.latestAny;
      const met = st.latestMetrics;

      return {
        location: String(loc),
        account: String((met?.account || any?.account || "") || ""),
        last_seen: String(any?.ts || any?.timestamp || any?.time || ""),
        uptime: Number(met?.uptime || 0),
        conversion: Number(met?.conversion || 0),
        response_ms: Number(met?.response_ms || 0),
        quotes_recovered: Number(met?.quotes_recovered || 0),
        integrity: getIntegrity(any),
      };
    });

    // Series (charts): metrics events only
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
      recent, // ✅ metrics-only (what your UI should show)
      locations,
      series,
      meta: {
        store: storeName,
        index_count,
      },
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
