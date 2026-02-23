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

// ---------- robust payload access (GHL wraps data in multiple ways) ----------
function getAny(e, key) {
  return (
    (e && e[key] !== undefined ? e[key] : undefined) ??
    (e?.data && e.data[key] !== undefined ? e.data[key] : undefined) ??
    (e?.customData && e.customData[key] !== undefined ? e.customData[key] : undefined) ??
    (e?.custom_data && e.custom_data[key] !== undefined ? e.custom_data[key] : undefined) ??
    (e?.payload && e.payload[key] !== undefined ? e.payload[key] : undefined) ??
    null
  );
}

function getStr(e, key, fallback = "") {
  const v = getAny(e, key);
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return fallback;
}

function getNumOrNull(e, key) {
  const v = getAny(e, key);
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Treat as "metrics/health" if it contains any non-zero numeric signal.
// IMPORTANT: do NOT treat missing metrics as zeros.
function hasMetrics(ev) {
  const u = getNumOrNull(ev, "uptime");
  const c = getNumOrNull(ev, "conversion");
  const r = getNumOrNull(ev, "response_ms");
  const q = getNumOrNull(ev, "quotes_recovered");
  return [u, c, r, q].some((v) => v !== null && v !== 0);
}

// Workflow/telemetry events: keep them from overwriting the tiles.
function isWorkflowEvent(ev) {
  const flags = [
    getAny(ev, "event_name"),
    getAny(ev, "stage"),
    getAny(ev, "priority"),
    getAny(ev, "acx_event"),
    getAny(ev, "acx_stage"),
    getAny(ev, "acx_status"),
  ];
  return flags.some((v) => v !== null && v !== undefined && v !== "");
}

// Integrity normalization:
// Allowed: ok / degraded / critical / unknown
// Map: optimal -> ok
function getIntegrity(ev) {
  const raw = String(
    getAny(ev, "acx_integrity") ?? getAny(ev, "integrity") ?? "unknown"
  )
    .toLowerCase()
    .trim();

  if (raw === "optimal") return "ok";
  if (raw === "ok" || raw === "degraded" || raw === "critical") return raw;
  return "unknown";
}

// Location normalization: never show [object Object]
function getLocationValue(ev) {
  const v =
    getAny(ev, "location") ??
    getAny(ev, "location_id") ??
    getAny(ev, "locationId") ??
    null;

  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if (v.id) return String(v.id);
    if (v.locationId) return String(v.locationId);
    if (v.location_id) return String(v.location_id);
    return "";
  }
  return "";
}

function getAccountValue(ev) {
  const v =
    getAny(ev, "account") ??
    getAny(ev, "account_name") ??
    getAny(ev, "accountName") ??
    "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
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
    getAny(e, "contact_id") ||
    getAny(e, "contactId") ||
    e?.contact?.id ||
    e?.data?.contact?.id ||
    null
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

// Works whether requireSession throws OR returns { ok, response }
async function enforceSession(req) {
  try {
    const res = await requireSession(req);
    if (res && typeof res === "object" && "ok" in res) {
      if (!res.ok)
        return res.response || json({ ok: false, error: "Unauthorized" }, 401);
      return null;
    }
    return null;
  } catch {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
}

export default async (req) => {
  try {
    if (req.method !== "GET")
      return json({ ok: false, error: "Method Not Allowed" }, 405);

    // KEEP LOGIN/session cookie
    const deny = await enforceSession(req);
    if (deny) return deny;

    const url = new URL(req.url);
    const limit = Math.max(
      1,
      Math.min(500, Number(url.searchParams.get("limit") || 50))
    );

    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    // Merge both indexes
    const idxEventsRaw = await readJSON(store, "index:events");
    const idxGlobalRaw = await readJSON(store, "index:global");

    const idxEvents = normalizeIndex(idxEventsRaw);
    const idxGlobal = normalizeIndex(idxGlobalRaw);

    let keys = dedupeKeepOrder([...idxEvents, ...idxGlobal]);
    keys = sortEventKeysAscending(keys);

    const index_count = keys.length;

    // newest last in index, so read from the end
    const tail = keys.slice(Math.max(0, keys.length - limit)).reverse();

    const events = [];
    for (const k of tail) {
      const ev = await readJSON(store, k);
      if (ev && typeof ev === "object") events.push(ev);
    }

    // Locations summary:
    // - last_seen + integrity: newest event of ANY type
    // - metrics tiles: newest METRICS event ONLY (workflow events cannot zero tiles)
    const locState = new Map();

    for (const ev of events) {
      const loc = getLocationValue(ev);
      if (!loc) continue;

      if (!locState.has(loc)) {
        locState.set(loc, {
          latestAny: ev,
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

      const u = met ? getNumOrNull(met, "uptime") : null;
      const c = met ? getNumOrNull(met, "conversion") : null;
      const r = met ? getNumOrNull(met, "response_ms") : null;
      const q = met ? getNumOrNull(met, "quotes_recovered") : null;

      return {
        location: String(loc),
        account: String((getAccountValue(met) || getAccountValue(any) || "") || ""),
        last_seen: String(getStr(any, "ts", "")),
        uptime: u == null ? 0 : toNum(u),
        conversion: c == null ? 0 : toNum(c),
        response_ms: r == null ? 0 : toNum(r),
        quotes_recovered: q == null ? 0 : toNum(q),
        integrity: getIntegrity(any),
      };
    });

    // Series (charts): metrics events only
    const series = {};
    for (const ev of events.slice().reverse()) {
      const loc = getLocationValue(ev);
      if (!loc) continue;

      if (!hasMetrics(ev) || isWorkflowEvent(ev)) continue;

      if (!series[loc]) series[loc] = [];
      series[loc].push({
        ts: getStr(ev, "ts", ""),
        uptime: toNum(getNumOrNull(ev, "uptime") ?? 0),
        conv: toNum(getNumOrNull(ev, "conversion") ?? 0),
        resp: toNum(getNumOrNull(ev, "response_ms") ?? 0),
        quotes: toNum(getNumOrNull(ev, "quotes_recovered") ?? 0),
        integrity: getIntegrity(ev),
      });
    }

    // --- Phase 2: WF3 enforcement + handled telemetry (additive-only) ---
    const wf3Stages = new Set(["t15", "t120", "eod"]);
    const wf3StallEvents = [];
    const handledEvents = [];

    for (const e of events) {
      const acx_event = getStr(e, "acx_event", "");
      const acx_stage = getStr(e, "acx_stage", "");
      const acx_status = getStr(e, "acx_status", "");

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

      const stage = getStr(e, "acx_stage", "");
      if (stalledByStage[stage]) stalledByStage[stage].add(cid);

      const t =
        toMs(getAny(e, "ts")) ||
        toMs(getAny(e, "created_at")) ||
        toMs(getAny(e, "time")) ||
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
        toMs(getAny(e, "ts")) ||
        toMs(getAny(e, "created_at")) ||
        toMs(getAny(e, "time")) ||
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

    // IMPORTANT: recent rows should NOT show fake 0.0 when metric fields are missing.
    // Return "" when missing so your existing HTML renders blanks.
    const recent = events.map((e) => {
      const u = getNumOrNull(e, "uptime");
      const c = getNumOrNull(e, "conversion");
      const r = getNumOrNull(e, "response_ms");
      const q = getNumOrNull(e, "quotes_recovered");

      return {
        ts: getStr(e, "ts", ""),
        account: getAccountValue(e),
        location: getLocationValue(e),
        uptime: u == null ? "" : u,
        conversion: c == null ? "" : c,
        response_ms: r == null ? "" : r,
        quotes_recovered: q == null ? "" : q,
        integrity: getIntegrity(e),
        run_id: getStr(e, "run_id", ""),
      };
    });

    return json({
      ok: true,
      recent,
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
