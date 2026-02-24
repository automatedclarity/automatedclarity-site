// functions/acx-matrix-ingest-form.js
// Browser-safe ingest relay (cookie session required)
// - Forwards to acx-matrix-webhook server-side with x-acx-secret
// - MUST send x-acx-source: ingest (so webhook can write summary metrics)

import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

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

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function toStr(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

// keep numeric strings clean (webhook already parses %, commas etc)
function toNumStr(v) {
  const s = toStr(v);
  return s;
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const deny = await enforceSession(req);
  if (deny) return deny;

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const account = toStr(pick(body, ["account", "account_name", "accountName"])) || "ACX";

  const location = toStr(
    pick(body, ["location", "location_id", "locationId"])
  );

  const run_id =
    toStr(pick(body, ["run_id", "runId", "test_run_id", "testRunId"])) ||
    `run_INGEST_FORM_${Date.now()}`;

  // LOCK: dashboard + summary expect acx_integrity / integrity, values ok|degraded|critical|unknown
  const acx_integrity = toStr(
    pick(body, ["acx_integrity", "integrity", "integrity_status", "integrityStatus"])
  ).toLowerCase();

  const uptime = toNumStr(pick(body, ["uptime", "uptime_pct", "uptimePct"]));
  const response_ms = toNumStr(pick(body, ["response_ms", "responseMs", "response"]));
  const conversion = toNumStr(pick(body, ["conversion", "conv"]));
  const quotes_recovered = toNumStr(
    pick(body, ["quotes_recovered", "quotesRecovered", "quotes"])
  );

  if (!location) {
    return json({ ok: false, error: "Missing required field: location" }, 400);
  }

  // SINGLE SOURCE OF TRUTH: ACX_SECRET (matches webhook + summary)
  const secret = (process.env.ACX_SECRET || "").trim();
  if (!secret) return json({ ok: false, error: "Server missing ACX_SECRET env var" }, 500);

  const origin = new URL(req.url).origin;

  // Forward to the single writer
  const forwardUrl = `${origin}/.netlify/functions/acx-matrix-webhook`;

  const payload = {
    account,
    location,
    run_id,
    acx_integrity,
    uptime,
    response_ms,
    conversion,
    quotes_recovered,
  };

  const r = await fetch(forwardUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
      // THIS IS THE FIX (was ingest_form). Must be EXACT "ingest".
      "x-acx-source": "ingest",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  try {
    return json({ ok: r.ok, forwarded: true, upstream: JSON.parse(text) }, r.status);
  } catch {
    return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
  }
};
