// functions/acx-matrix-ingest-form.js
// Deterministic browser-safe ingest relay
// Single responsibility: validate session -> forward JSON -> return upstream result

import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

export default async (req) => {
  // ✅ Only POST
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  // ✅ Require session cookie
  try {
    await requireSession(req);
  } catch {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  // ✅ Parse JSON body
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // ✅ Minimal validation (only required fields)
  const account = String(body.account || "").trim();
  const location = String(body.location || "").trim();

  if (!account || !location) {
    return json({ ok: false, error: "Missing account or location" }, 400);
  }

  // ✅ Use exact same payload structure curl uses
  const payload = {
    account,
    location,
    run_id: body.run_id || `run_FORM_${Date.now()}`,
    acx_integrity: body.acx_integrity || "",
    uptime: body.uptime || "",
    response_ms: body.response_ms || "",
    conversion: body.conversion || "",
    quotes_recovered: body.quotes_recovered || "",
  };

  const secret =
    process.env.ACX_SECRET ||
    process.env.ACX_WEBHOOK_SECRET ||
    process.env.X_ACX_SECRET;

  if (!secret) {
    return json({ ok: false, error: "Missing ACX secret" }, 500);
  }

  // ✅ Always forward to webhook (single source of truth)
  const forwardUrl = new URL(req.url).origin +
    "/.netlify/functions/acx-matrix-webhook";

  const upstream = await fetch(forwardUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
    },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
};
