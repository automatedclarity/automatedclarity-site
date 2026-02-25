// functions/acx-matrix-ingest-form.js
// Browser-safe ingest relay (cookie session required)
// - Forwards to acx-matrix-webhook server-side with x-acx-secret
// - MUST send x-acx-source: ingest (so webhook can write summary metrics)
// - Empire: missing/blank/invalid metrics become null (NOT 0)
// - Supports metrics top-level OR inside data:{...}

import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// ---------- AUTH ----------
async function enforceSession(req) {
  try {
    const res = await requireSession(req);

    // supports both patterns:
    // - requireSession throws on fail
    // - OR returns { ok, response }
    if (res && typeof res === "object" && "ok" in res) {
      if (res.ok) return null;
      return res.response || json({ ok: false, error: "Unauthorized" }, 401);
    }

    // if it returned a Response directly, pass it through
    if (res instanceof Response) return res;

    return null; // session ok
  } catch {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
}

// ---------- helpers ----------
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function getField(body, keys) {
  // supports both top-level and body.data.*
  const top = pick(body, keys);
  if (top !== "") return top;
  return pick(body?.data, keys);
}

function toStr(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normalizeIntegrity(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (v === "ok") return "ok";
  if (v === "degraded" || v === "warn" || v === "warning") return "degraded";
  if (v === "critical" || v === "crit" || v === "down") return "critical";
  return "unknown";
}

function toNumberOrNull(raw) {
  // Empire: treat "", null, undefined, invalid as null (missing)
  if (raw === undefined || raw === null) return null;

  const s = String(raw).trim();
  if (!s) return null;

  // allow "99.9%" and "1,234"
  const cleaned = s.replace(/%/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function requireNonEmpty(name, value) {
  if (!value || !String(value).trim()) {
    return json({ ok: false, error: `Missing required field: ${name}` }, 400);
  }
  return null;
}

// ---------- main ----------
export default async (req) => {
  if (req.method !== "POST")
    return json({ ok: false, error: "Method Not Allowed" }, 405);

  const deny = await enforceSession(req);
  if (deny) return deny;

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const account =
    toStr(getField(body, ["account", "account_name", "accountName"])) || "ACX";

  const location = toStr(
    getField(body, ["location", "location_id", "locationId", "locationID"])
  );

  const missingLoc = requireNonEmpty("location", location);
  if (missingLoc) return missingLoc;

  const run_id =
    toStr(getField(body, ["run_id", "runId", "test_run_id", "testRunId"])) ||
    `run_INGEST_FORM_${Date.now()}`;

  // LOCK: ok|degraded|critical|unknown
  const acx_integrity = normalizeIntegrity(
    getField(body, [
      "acx_integrity",
      "integrity",
      "integrity_status",
      "integrityStatus",
    ])
  );

  // metrics — support multiple key aliases
  const uptime = toNumberOrNull(
    getField(body, ["uptime", "uptime_pct", "uptimePct"])
  );
  const response_ms = toNumberOrNull(
    getField(body, ["response_ms", "responseMs", "response", "resp"])
  );
  const conversion = toNumberOrNull(getField(body, ["conversion", "conv"]));
  const quotes_recovered = toNumberOrNull(
    getField(body, ["quotes_recovered", "quotesRecovered", "quotes"])
  );

  // SINGLE SOURCE OF TRUTH: ACX_SECRET (matches webhook + summary)
  const secret = (process.env.ACX_SECRET || "").trim();
  if (!secret)
    return json({ ok: false, error: "Server missing ACX_SECRET env var" }, 500);

  // Forward to the single writer (same origin in prod)
  const origin = new URL(req.url).origin;
  const forwardUrl = `${origin}/.netlify/functions/acx-matrix-webhook`;

  // Build payload; omit null metrics entirely to avoid any downstream ambiguity
  const payload = {
    account,
    location,
    run_id,
    acx_integrity,
  };

  if (uptime !== null) payload.uptime = uptime;
  if (response_ms !== null) payload.response_ms = response_ms;
  if (conversion !== null) payload.conversion = conversion;
  if (quotes_recovered !== null) payload.quotes_recovered = quotes_recovered;

  const r = await fetch(forwardUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
      // MUST be EXACT "ingest"
      "x-acx-source": "ingest",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  try {
    return json({ ok: r.ok, forwarded: true, upstream: JSON.parse(text) }, r.status);
  } catch {
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
};
