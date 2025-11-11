// functions/auth-check.js
import { readSession } from "./_lib/session.js";

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const sess = readSession(req);
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (!sess) {
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
