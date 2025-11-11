// functions/auth-logout.js
import { clearSessionCookie } from "./_lib/session.js";

export default async (req) => {
  // Accept GET or POST so the topbar link works
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const cookie = clearSessionCookie();
  // Redirect to login after clearing
  return new Response("", {
    status: 303,
    headers: {
      "Set-Cookie": cookie,
      "Location": "/matrix-login",
      "Cache-Control": "no-store"
    }
  });
};
