// functions/acx-matrix-ingest-form.js
// Browser ingest form -> server-side forwarder (no secrets in client)
// - Requires session cookie (same auth model as /matrix)
// - Forwards payload to acx-matrix-webhook with x-acx-secret + x-acx-source: ingest
// - Ensures integrity enum only: ok | degraded | critical (else -> unknown)

import { requireSession } from "./_lib/session.js";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });

const normIntegrity = (v) => {
  const s = String(v || "").trim().toLowerCase();
  if (s === "ok") return "ok";
  if (s === "degraded") return "degraded";
  if (s === "critical") return "critical";
  return "unknown";
};

export default async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST")
    return json(405, { ok: false, error: "Method Not Allowed" });

  // cookie session only
  try {
    await requireSession(req);
  } catch {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  const secret = process.env.ACX_SECRET || "";
  if (!secret) return json(500, { ok: false, error: "Server missing ACX_SECRET" });

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // normalize integrity to locked enum
  if ("acx_integrity" in body) body.acx_integrity = normIntegrity(body.acx_integrity);
  if ("integrity" in body) body.integrity = normIntegrity(body.integrity);

  // build absolute URL to webhook (works on Netlify)
  const base =
    process.env.URL ||
    (req.headers.get("x-forwarded-proto") && req.headers.get("host")
      ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("host")}`
      : "");

  if (!base) return json(500, { ok: false, error: "Unable to resolve base URL" });

  const forwardUrl = `${base}/.netlify/functions/acx-matrix-webhook`;

  const r = await fetch(forwardUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
      "x-acx-source": "ingest",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let out = null;
  try {
    out = JSON.parse(text);
  } catch {
    out = { raw: text };
  }

  return json(r.status, out);
};
