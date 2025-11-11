import { clearSessionCookie } from "./_lib/session.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const cookie = clearSessionCookie();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
};
