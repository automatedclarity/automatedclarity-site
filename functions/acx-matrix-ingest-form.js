// functions/acx-matrix-ingest-form.js
// Browser-safe ingest relay:
// - Requires cookie session (same auth model as /matrix)
// - Forwards to acx-matrix-webhook with x-acx-secret server-side
// - Sends x-acx-source in a way that ALWAYS allows metric overwrite

import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
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

function toStringSafe(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

export default async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const deny = await enforceSession(req);
  if (deny) return deny;

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const account = toStringSafe(
    pick(body, ["account", "account_name", "accountName", "AccountName"])
  );

  const location = toStringSafe(
    pick(body, ["location", "location_id", "locationId", "Location", "LocationId"])
  );

  const run_id =
    toStringSafe(
      pick(body, ["run_id", "runId", "test_run_id", "testRunId", "TestRunID"])
    ) || `run_INGEST_FORM_${Date.now()}`;

  const acx_integrity = toStringSafe(
    pick(body, ["acx_integrity", "integrity", "integrity_status", "integrityStatus"])
  );

  const uptime = toStringSafe(pick(body, ["uptime", "uptime_pct", "uptimePct"]));
  const response_ms = toStringSafe(
    pick(body, ["response_ms", "responseMs", "response"])
  );
  const conversion = toStringSafe(pick(body, ["conversion", "conv", "Conv"]));
  const quotes_recovered = toStringSafe(
    pick(body, ["quotes_recovered", "quotesRecovered", "quotes", "QuotesRecovered"])
  );

  if (!account || !location) {
    return json(
      { ok: false, error: "Missing required fields: account, location" },
      400
    );
  }

  const secret =
    process.env.ACX_SECRET ||
    process.env.ACX_WEBHOOK_SECRET ||
    process.env.ACX_MATRIX_SECRET ||
    process.env.ACX_SHARED_SECRET ||
    process.env.X_ACX_SECRET;

  if (!secret) {
    return json({ ok: false, error: "Server missing ACX secret env var" }, 500);
  }

  const origin = new URL(req.url).origin;
  const forwardUrl = `${origin}/.netlify/functions/acx-matrix-webhook`;

  const payload = {
    account,
    location,
    run_id,
    acx_integrity,
    integrity: acx_integrity, // send both keys (no drift)
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

      // EMPIRE: always treated as metric-writing source
      "x-acx-source": "ingest",
      "x-acx-source-detail": "ingest_form",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();

  try {
    return json({ ok: true, forwarded: true, upstream: JSON.parse(text) }, r.status);
  } catch {
    return new Response(text, {
      status: r.status,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
