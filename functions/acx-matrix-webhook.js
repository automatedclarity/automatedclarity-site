import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { normalize } from "./_lib/shape.js";
import { getStore } from "./_lib/store.js";   // NEW

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}

  const data = normalize(body);

  // Single structured line for logs
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

  // Append to blob as JSONL
  try {
    const store = getStore("matrix/logs.jsonl");
    const row = { ts: new Date().toISOString(), ...data };
    await store.append(JSON.stringify(row) + "\n");
  } catch (e) {
    console.warn("MATRIX_STORE_FAIL " + (e?.message || e));
  }

  return new Response(JSON.stringify({ ok: true, message: "Matrix data received" }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
};
