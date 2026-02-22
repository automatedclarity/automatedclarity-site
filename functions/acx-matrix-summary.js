// netlify/functions/acx-matrix-summary.js
import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// ✅ ADD: header auth fallback for curl/testing (uses ACX_SECRET only)
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

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Treat as "metrics/health" if it contains any non-zero numeric signal.
// This prevents workflow events (often 0s) from overwriting dashboard tiles.
function hasMetrics(ev) {
  const u = toNum(ev?.uptime, null);
  const c = toNum(ev?.conversion, null);
  const r = toNum(ev?.response_ms, null);
  const q = toNum(ev?.quotes_recovered, null);
  return [u, c, r, q].some((v) => v !== null && v !== 0);
}

// includes Phase 2 telemetry keys so WF3/handled don't overwrite tiles
function isWorkflowEvent(ev) {
  return !!(
    ev?.event_name ||
    ev?.stage ||
    ev?.priority ||
    ev?.acx_event ||
    ev?.acx_stage ||
    ev?.acx_status
  );
}

// Additive integrity normalization (supports old "integrity" + new "acx_integrity")
function getIntegrity(ev) {
  const v = String(ev?.acx_integrity || ev?.integrity || "unknown").toLowerCase();
  return v || "unknown";
}

// --- Phase 2 helpers (additive-only) ---
function toMs(v) {
  if (!v) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function getContactId(e) {
  return (
    e?.contact_id ||
    e?.contactId ||
    e?.contact?.id ||
    e?.data?.contact_id ||
    e?.data?.contactId ||
    e?.data?.contact?.id ||
    null
  );
}

function getField(e, key) {
  return e?.[key] ?? e?.data?.[key] ?? null;
}

export default async (req) => {
  try {
    if (req.method !== "GET")
      return json({ ok: false, error: "Method Not Allowed" }, 405);

    // ✅ KEEP LOGIN EXACTLY AS BEFORE (session cookie) for dashboard
    // ✅ BUT allow x-acx-secret for curl/testing
    if (!checkAuth(req)) {
      const s = requireSession(req);
      if (!s.ok) return s.response;
    }

    const url = new URL(req.url);
    const limit = Math.max(
      1,
      Math.min(500, Number(url.searchParams.get("limit") || 50))
    );

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // ✅ KEY FIX: support both index keys (additive only)
    // - prefer index:events (existing)
    // - fallback to index:global (what webhook writes in your pasted code)
    let idxRaw = await readJSON(store, "index:events");
    let keys = normalizeIndex(idxRaw);

    if (!keys.length) {
      const idxGlobal = await readJSON(store, "index:global");
      keys = normalizeIndex(idxGlobal);
    }

    const index_count = keys.length;

    // newest last in our index, so read from the end
    const tail = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const events = [];
    for (const k of tail) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") events.push(ev);
    }

    // Locations summary (additive):
    // - last_seen + integrity come from newest event of ANY type
    // - metrics come from newest METRICS event (so workflow events can't zero tiles)
    const locState = new Map();

    for (const ev of events) {
      const loc = String(ev.location || "");
      if (!loc) continue;

      if (!locState.has(loc)) {
        locState.set(loc, {
          latestAny: ev, // events are newest-first
          latestMetrics: null, // fill once with newest metrics event
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
        last_seen: String(any?.ts || ""),
        uptime: toNum(met?.uptime),
        conversion: toNum(met?.conversion),
        response_ms: toNum(met?.response_ms),
        quotes_recovered: toNum(met?.quotes_recovered),
        integrity: getIntegrity(any),
      };
    });

    // Series (charts): metrics events only
    const series = {};
    for (const ev of events.slice().reverse()) {
      const loc = String(ev.location || "");
      if (!loc) continue;

      if (!hasMetrics(ev) || isWorkflowEvent(ev)) continue;

      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: ev.ts,
        uptime: toNum(ev.uptime),
        conv: toNum(ev.conversion),
        resp: toNum(ev.response_ms),
        quotes: toNum(ev.quotes_recovered),
        integrity: getIntegrity(ev),
      });
    }

    // --- Phase 2: WF3 enforcement + handled telemetry (additive-only) ---
    const wf3Stages = new Set(["t15", "t120", "eod"]);
    const wf3StallEvents = [];
    const handledEvents = [];

    for (const e of events) {
      const acx_event = getField(e, "acx_event");
      const acx_stage = getField(e, "acx_stage");
      const acx_status = getField(e, "acx_status");

      if (
        acx_event === "wf3_enforcement" &&
        wf3Stages.has(acx_stage) &&
        acx_status === "stall"
      ) {
        wf3StallEvents.push(e);
        continue;
      }

      if (acx_event === "handled" && acx_status === "handled") {
        handledEvents.push(e);
        continue;
      }
    }

    const stalledByStage = { t15: new Set(), t120: new Set(), eod: new Set() };
    const firstStallAtByContact = new Map();

    for (const e of wf3StallEvents) {
      const cid = getContactId(e);
      if (!cid) continue;

      const stage = getField(e, "acx_stage");
      if (stalledByStage[stage]) stalledByStage[stage].add(cid);

      const t =
        toMs(getField(e, "ts")) ||
        toMs(getField(e, "created_at")) ||
        toMs(getField(e, "time")) ||
        toMs(e?.createdAt) ||
        toMs(e?.timestamp) ||
        null;

      if (!t) continue;

      const prev = firstStallAtByContact.get(cid);
      if (prev == null || t < prev) firstStallAtByContact.set(cid, t);
    }

    const handledAtByContact = new Map();
    for (const e of handledEvents) {
      const cid = getContactId(e);
      if (!cid) continue;

      const t =
        toMs(getField(e, "ts")) ||
        toMs(getField(e, "created_at")) ||
        toMs(getField(e, "time")) ||
        toMs(e?.createdAt) ||
        toMs(e?.timestamp) ||
        null;

      if (!t) continue;

      const prev = handledAtByContact.get(cid);
      if (prev == null || t < prev) handledAtByContact.set(cid, t);
    }

    let stalledContacts = 0;
    let recoveredContacts = 0;
    let responseTimeSumMs = 0;
    let responseTimeCount = 0;

    for (const [cid, stallAt] of firstStallAtByContact.entries()) {
      stalledContacts += 1;

      const handledAt = handledAtByContact.get(cid);
      if (handledAt != null && handledAt >= stallAt) {
        recoveredContacts += 1;

        const dt = handledAt - stallAt;
        if (dt >= 0) {
          responseTimeSumMs += dt;
          responseTimeCount += 1;
        }
      }
    }

    const avgResponseMs = responseTimeCount
      ? Math.round(responseTimeSumMs / responseTimeCount)
      : null;
    const recoveryRate = stalledContacts ? recoveredContacts / stalledContacts : null;

    return json({
      ok: true,
      recent: events,
      locations,
      series,
      meta: {
        store: storeName,
        index_count,
        wf3: {
          stalls_unique_by_stage: {
            t15: stalledByStage.t15.size,
            t120: stalledByStage.t120.size,
            eod: stalledByStage.eod.size,
          },
          stalled_contacts: stalledContacts,
          recovered_contacts: recoveredContacts,
          recovery_rate: recoveryRate,
          avg_response_ms: avgResponseMs,
          avg_response_seconds:
            avgResponseMs != null ? Math.round(avgResponseMs / 1000) : null,
        },
      },
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
