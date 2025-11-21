// netlify/functions/acx-matrix-ingest.js

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

  // Minimal ACX-only schema: usage, asset, health, guidance
  const cleanPayload = {
    account,
    location,
    period,
    run_id,
    engine: {
      // How many people actually came through ACX doors this period
      contacts_through_acx: Number(engine.contacts_through_acx || 0),

      // Total number of contacts grown inside ACX (never imported)
      list_size_total: Number(engine.list_size_total || 0),

      // Contacts that haven't engaged in 90+ days
      dormant_90d: Number(engine.dormant_90d || 0)
    },
    sentinel: {
      // "ok" | "warning" | "critical" | "unknown"
      status: (sentinel.status || "unknown").toString()
    },
    matrix: {
      // Short human summary
      summary: (matrix.summary || "").toString(),

      // One simple recommendation to increase ROI on ACX
      recommendation: (matrix.recommendation || "").toString(),

      // Internal tags (e.g. ["octane_ready","low_usage"])
      tags: Array.isArray(matrix.tags) ? matrix.tags.map(String) : []
    }
  };

  console.log("MATRIX_INGEST", cleanPayload);

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
