import { setSessionCookie } from "./_lib/session.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body = {}; try { body = await req.json(); } catch {}
  const password = (body && body.password) || "";
  const expected = (process.env.ACX_DASH_PASS || "").trim();
  if (!expected) {
    return new Response(JSON.stringify({ ok: false, error: "Server not configured" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  if (!password || password !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid password" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const cookie = setSessionCookie(req);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
};
