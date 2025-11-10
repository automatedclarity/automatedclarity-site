// functions/auth-login.js
import { makeSessionCookie } from "./_lib/session.js";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const supplied = String(body.password || "");
  const expected = process.env.ACX_DASH_PASS || "";
  const key = process.env.ACX_SESSION_KEY || "";

  if (!expected || !key || supplied !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": makeSessionCookie(key),
      "Cache-Control": "no-store",
    },
  });
};
