// functions/acx-matrix-ingest-integrity.js
// EMPIRE FIX:
// This endpoint must NOT write blobs directly.
// It must forward into acx-matrix-webhook (single source of truth),
// because the dashboard reads the webhook schema only.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Handle GHL “standard data” where location might come as object
function coerceLocationId(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const maybe =
      v.id || v.location_id || v.locationId || v._id || v.value || "";
    return String(maybe || "").trim();
  }
  return String(v).trim();
}

// Allow both secrets so you don’t get locked out by env drift
function authOk(req) {
  const got = (req.headers.get("x-acx-secret") || "").trim();

  const expectedA = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  const expectedB = (process.env.ACX_SECRET || "").trim();
  const expectedC = (process.env.X_ACX_SECRET || "").trim();

  if (!got) return false;
  if (expectedA && got === expectedA) return true;
  if (expectedB && got === expectedB) return true;
  if (expectedC && got === expectedC) return true;

  return false;
}

export default async (req) => {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200);
    if (req.method !== "POST")
      return json({ ok: false, error: "Method Not Allowed" }, 405);

    if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Bad JSON" }, 400);
    }

    // Accept both keys, prefer explicit "integrity"
    const integrityRaw = pickFirst(body, ["integrity", "acx_integrity"]);
    const integrity = String(integrityRaw || "").toLowerCase().trim();

    // Accept location OR location_id OR locationId and handle object
    const location = coerceLocationId(
      pickFirst(body, ["location", "location_id", "locationId"])
    );

    const account = String(pickFirst(body, ["account", "account_name"]) || "ACX").trim() || "ACX";
    const run_id =
      String(pickFirst(body, ["run_id", "runId"]) || "").trim() ||
      `run-${Date.now()}`;

    if (!location) return json({ ok: false, error: "Missing location" }, 400);

    // We do NOT validate integrity here beyond basic presence,
    // because acx-matrix-webhook is the canonical normalizer.
    // (webhook maps optimal->ok, unknown->missing, etc.)
    const payload = {
      account,
      location,
      run_id,

      // send BOTH keys so webhook can normalize reliably
      acx_integrity: integrity,
      integrity: integrity,
      // allow optional metrics passthrough if provided
      uptime: body.uptime ?? "",
      conversion: body.conversion ?? "",
      response_ms: body.response_ms ?? "",
      quotes_recovered: body.quotes_recovered ?? "",

      // preserve source if caller provided it
      source: String(pickFirst(body, ["source"]) || "sentinel").trim(),
    };

    // Forward to the single writer
    const origin = new URL(req.url).origin;
    const forwardUrl = `${origin}/.netlify/functions/acx-matrix-webhook`;

    // Use the SAME secret the webhook expects
    const secret =
      (process.env.ACX_SECRET || "").trim() ||
      (process.env.ACX_WEBHOOK_SECRET || "").trim() ||
      (process.env.X_ACX_SECRET || "").trim();

    if (!secret) {
      return json({ ok: false, error: "Server missing ACX secret env var" }, 500);
    }

    const upstream = await fetch(forwardUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acx-secret": secret,

        // ✅ Critical: allow summary metric writes when metrics are included
        // (and keep behavior consistent with curl)
        "x-acx-source": "ingest",
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();

    // Pass through upstream as-is
    try {
      return json({ ok: true, forwarded: true, upstream: JSON.parse(text) }, upstream.status);
    } catch {
      return new Response(text, {
        status: upstream.status,
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
  } catch (e) {
    return json({ ok: false, error: e?.message || "Unknown error" }, 500);
  }
};
