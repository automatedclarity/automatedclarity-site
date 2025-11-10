import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { normalize } from "./_lib/shape.js";

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}

  // 🔎 DEBUG (temporary): print exactly what GHL sends
  console.info("MATRIX_RAW " + JSON.stringify(body));

  const data = normalize(body);

  // EXACTLY ONE LINE for ingest:
  console.info(
    "MATRIX_INGEST " +
      JSON.stringify({
        account: data.account,
        location: data.location,
        uptime: data.uptime,
        conversion: data.conversion,
        response_ms: data.response_ms,
        quotes_recovered: data.quotes_recovered,
        integrity: data.integrity,
        run_id: data.run_id,
      })
  );

  return new Response(JSON.stringify({ ok: true, message: "Matrix data received" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
