import { createSession, setCookie } from "./_lib/session.js";

export default async (req) => {
  if (req.method !== "POST")
    return new Response(JSON.stringify({ ok:false, error:"Method Not Allowed" }), { status:405 });

  const body = await req.json().catch(()=> ({}));
  const pass = String(body.password || "");
  if (pass !== (process.env.ACX_DASH_PASS || ""))
    return new Response(JSON.stringify({ ok:false, error:"Invalid password" }), { status:401 });

  const token = createSession("dashboard");
  return new Response(JSON.stringify({ ok:true }), {
    status: 200,
    headers: { "Set-Cookie": setCookie(token), "Content-Type":"application/json" }
  });
};
