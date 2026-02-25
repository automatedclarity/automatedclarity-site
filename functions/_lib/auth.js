// functions/_lib/auth.js
export function checkAuth(req) {
  const header = (req.headers.get("x-acx-secret") || "").trim();
  const expected = (process.env.ACX_SECRET || "").trim(); // single source of truth
  return !!header && !!expected && header === expected;
}

export function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405 });
}
