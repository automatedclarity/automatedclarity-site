// functions/auth-check.js
import { readSession } from "./_lib/session.js";

export default async (req) => {
  const s = readSession(req);
  return new Response(JSON.stringify({ ok: s.ok }), {
    status: s.ok ? 200 : 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
