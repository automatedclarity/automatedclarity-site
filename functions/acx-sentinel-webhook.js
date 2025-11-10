import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try { body = await req.json(); } catch {}

  return new Response(
    JSON.stringify({ ok: true, message: "ACX Sentinel active", received: body || {} }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};
