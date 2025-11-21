// netlify/functions/acx-matrix-webhook.js
// ACX Matrix Webhook – ACX-only ingest + Netlify Blobs persistence

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Bearer token auth using ACX_WEBHOOK_SECRET
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token || token !== process.env.ACX_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch (e) {
    console.error("MATRIX_INGEST: invalid JSON body", e);
    return new Response("Bad Request", { status: 400 });
  }

  const {
    account = "",
    location = "",
    period = "",
    run_id = "",
    engine = {},
    sentinel = {},
    matrix = {}
  } = body || {};

  // Minimal, empire-safe, ACX-only schema
  const cleanPayload = {
    account,
    location,
    period,
    run_id: run_id || `run-${Date.now()}`,
    engine: {
      contacts_through_acx: Number(engine.contacts_through_acx || 0),
      list_size_total: Number(engine.list_size_total || 0),
      dormant_90d: Number(engine.dormant_90d || 0)
    },
    sentinel: {
      status: (sentinel.status || "unknown").toString()
    },
    matrix: {
      summary: (matrix.summary || "").toString(),
      recommendation: (matrix.recommendation || "").toString(),
      tags: Array.isArray(matrix.tags) ? matrix.tags.map(String) : []
    },
    created_at: new Date().toISOString()
  };

  console.log("MATRIX_INGEST", cleanPayload);

  try {
    // Store each run as a JSON blob keyed by run_id
    const store = getStore("acx-matrix-runs");
    await store.setJSON(cleanPayload.run_id, cleanPayload);
  } catch (e) {
    console.error("MATRIX_INGEST: failed to write to blobs", e);
    // We still return ok=true so one bad write doesn’t break webhooks
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "ACX Matrix ingest recorded",
      received: cleanPayload
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
};
