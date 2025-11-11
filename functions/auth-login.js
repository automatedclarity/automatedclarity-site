// functions/auth-login.js
import { setSessionCookie } from "./_lib/session.js";

async function readBody(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return await req.json(); } catch {}
    return {};
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
  // best-effort
  try { return await req.json(); } catch {}
  return {};
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await readBody(req);
  const password = (body.password || "").trim();
  const expected = (process.env.ACX_DASH_PASS || "").trim();

  if (!expected) {
    return new Response(JSON.stringify({ ok:false, error:"Server not configured" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
  if (!password || password !== expected) {
    // If form post, show a small HTML error to keep flow simple
    if ((req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><script>location.href="/matrix-login?e=bad"</script>`, 
        { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }
    return new Response(JSON.stringify({ ok:false, error:"Invalid password" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  const cookie = setSessionCookie(req);

  // If it was a form post, do a 303 redirect so browsers persist and navigate
  if ((req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
    return new Response("", {
      status: 303,
      headers: {
        "Set-Cookie": cookie,
        "Location": "/matrix",
        "Cache-Control": "no-store"
      }
    });
  }

  // JSON clients still get JSON
  return new Response(JSON.stringify({ ok:true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
      "Cache-Control": "no-store"
    }
  });
};
