// functions/acx-matrix-ingest-form.js
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

function normalizeIntegrity(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "ok") return "ok";
  if (s === "degraded") return "degraded";
  if (s === "critical") return "critical";
  return "unknown";
}

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function enforceSession(req) {
  try {
    const res = await requireSession(req);
    if (res instanceof Response) return json({ ok: false, error: "Unauthorized" }, 401);
    if (res && typeof res === "object" && "ok" in res && !res.ok)
      return json({ ok: false, error: "Unauthorized" }, 401);
    return null;
  } catch {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
}

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

  const location = String(body.location || "").trim();
  if (!location)
    return json({ ok: false, error: "Missing location" }, 400);

  const account = String(body.account || "ACX").trim();

  const payload = {
    account,
    location,
    run_id: String(body.run_id || `run_${Date.now()}`),
    acx_integrity: normalizeIntegrity(body.acx_integrity || body.integrity),
    uptime: toNumberOrZero(body.uptime),
    conversion: toNumberOrZero(body.conversion),
    response_ms: toNumberOrZero(body.response_ms),
    quotes_recovered: toNumberOrZero(body.quotes_recovered),
  };

  const secret = process.env.ACX_SECRET;
  if (!secret)
    return json({ ok: false, error: "Server missing ACX_SECRET" }, 500);

  const origin = new URL(req.url).origin;

  const r = await fetch(`${origin}/.netlify/functions/acx-matrix-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
      "x-acx-source": "ingest",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {}

  return json({
    ok: r.ok,
    forwarded: true,
    upstream: parsed || text,
  }, r.status);
};
