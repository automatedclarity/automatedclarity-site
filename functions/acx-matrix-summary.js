// functions/acx-matrix-summary.js
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

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Treat as "metrics/health" if it contains any non-zero numeric signal.
// This prevents WF3 events (which often have 0s) from overwriting dashboard tiles.
function hasMetrics(ev) {
  const u = toNum(ev?.uptime, null);
  const c = toNum(ev?.conversion, null);
  const r = toNum(ev?.response_ms, null);
  const q = toNum(ev?.quotes_recovered, null);
  return [u, c, r, q].some((v) => v !== null && v !== 0);
}

// ✅ UPDATED: include Phase 2 telemetry keys so WF3/handled don't overwrite tiles
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

// ✅ Additive integrity normalization (supports old "integrity" + new "acx_integrity")
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
    if (req.method !== "GET") return json({ ok: false, error: "Method Not Allowed" }, 405);

    // ✅ dashboard access uses session cookie, not x-acx-secret
    const s = requireSession(req);
    if (!s.ok) return s.response;

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)));

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const idxRaw = await readJSON(store, "index:events");
    const keys = normalizeIndex(idxRaw);
    const index_count = keys.length;

    // newest last in our index, so read from the end
    const tail = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const events = [];
    for (const k of tail) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") events.push(ev);
    }

    // Locations summary:
    // - Use the most recent METRICS event per location for tiles.
    // - Keep recent feed as-is (includes workflow events).
    const byLoc = new Map();
    for (const ev of events) {
      const loc = String(ev.location || "");
      if (!loc) continue;

      if (!byLoc.has(loc)) {
        byLoc.set(loc, ev); // events are newest-first
        continue;
      }

      const cur = byLoc.get(loc);
      const curIsMetrics = hasMetrics(cur) && !isWorkflowEvent(cur);
      const evIsMetrics = hasMetrics(ev) && !isWorkflowEvent(ev);

      // Upgrade selection if this event is a metrics event and current isn't.
      if (!curIsMetrics && evIsMetrics) byLoc.set(loc, ev);
    }

    const locations = Array.from(byLoc.values()).map((ev) => ({
      location: String(ev.location || ""),
      account: String(ev.account || ""),
      last_seen: String(ev.ts || ""),
      uptime: toNum(ev.uptime),
      conversion: toNum(ev.conversion),
      response_ms: toNum(ev.response_ms),
      quotes_recovered: toNum(ev.quotes_recovered),
      integrity: getIntegrity(ev),
    }));

    // Series (charts): metrics events only (so workflow events don't flatten charts to zeros)
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

      if (acx_event === "wf3_enforcement" && wf3Stages.has(acx_stage) && acx_status === "stall") {
        wf3StallEvents.push(e);
        continue;
      }

      if (acx_event === "handled" && acx_status === "handled") {
        handledEvents.push(e);
        continue;
      }
    }

    const stalledByStage = { t15: new Set(), t120: new Set(), eod: new Set() };
    const firstStallAtByContact = new Map(); // contactId -> ms

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

    const handledAtByContact = new Map(); // contactId -> ms
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

    const avgResponseMs = responseTimeCount ? Math.round(responseTimeSumMs / responseTimeCount) : null;
    const recoveryRate = stalledContacts ? recoveredContacts / stalledContacts : null;

    return json({
      ok: true,
      recent: events, // includes everything (metrics + workflow)
      locations,      // prefers latest metrics per location
      series,         // metrics-only charts
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
          recovery_rate: recoveryRate, // 0..1
          avg_response_ms: avgResponseMs,
          avg_response_seconds: avgResponseMs != null ? Math.round(avgResponseMs / 1000) : null,
        },
      },
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
