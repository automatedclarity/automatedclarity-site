// ACX Matrix — Writer (webhook)
// Accepts either flat JSON or { customData: { ... } } and writes a normalized event
import { getStore } from "@netlify/blobs";

const STORE  = "acx_matrix_events";   // <- forced match
const PREFIX = "event:";              // <- forced match

function readSecret(req) {
  const h = req.headers.get("x-acx-secret") || "";
  return h.trim();
}

function badRequest(msg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

export default async (req) => {
  if (req.method !== "POST") {
    return badRequest("Method Not Allowed", 405);
  }

  // simple shared-secret auth for write
  const provided = readSecret(req);
  const expected = process.env.ACX_WEBHOOK_SECRET || "";
  if (!expected || provided !== expected) {
    return badRequest("Unauthorized", 401);
  }

  let body = {};
  try { body = await req.json(); } catch (_) {}

  const src = body.customData && typeof body.customData === "object"
    ? body.customData
    : body;

  const nowIso = new Date().toISOString();

  const event = {
    ts: nowIso,
    account:        String(src.account || src.account_name || "").trim(),
    location:       String(src.location || src.location_id || "").trim(),
    uptime:         src.uptime ?? src["uptime%"] ?? src.uptime_percent ?? "",
    conversion:     src.conversion ?? src["conversion%"] ?? "",
    response_ms:    src.response_ms ?? src.response ?? "",
    quotes_recovered: src.quotes_recovered ?? src.quotes ?? "",
    integrity:      (src.integrity || src.integrity_status || "unknown").toLowerCase(),
    run_id:         String(src.run_id || "").trim(),
  };

  const store = getStore(STORE);
  // key: event:<epoch>-<location>
  const keySafeLoc = (event.location || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${PREFIX}${Date.now()}-${keySafeLoc}`;

  await store.setJSON(key, event);

  return new Response(JSON.stringify({ ok: true, message: "Matrix data received" }), {
    headers: { "Content-Type": "application/json" },
  });
};
