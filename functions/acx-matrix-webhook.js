import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { normalize } from "./_lib/shape.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX   = "event:"; // ← MUST MATCH READERS

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}
  const data = normalize(body);

  console.info("MATRIX_INGEST " + JSON.stringify({
    account: data.account,
    location: data.location,
    uptime: data.uptime,
    conversion: data.conversion,
    response_ms: data.response_ms,
    quotes_recovered: data.quotes_recovered,
    integrity: data.integrity,
    run_id: data.run_id
  }));

  try {
    const store = getStore({ name: STORE });
    const key = `${PFX}${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`;
    const event = { ts: new Date().toISOString(), ...data };
    await store.set(key, JSON.stringify(event), { contentType: "application/json" });
    console.info("MATRIX_WRITE " + JSON.stringify({ store: STORE, key }));
  } catch (e) {
    console.warn("MATRIX_STORE_FAIL " + (e?.message || String(e)));
  }

  return new Response(JSON.stringify({ ok: true, message: "Matrix data received" }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
};
