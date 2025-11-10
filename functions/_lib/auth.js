export function checkAuth(req) {
  const header = req.headers.get("x-acx-secret") || "";
  const ok = !!header && header === (process.env.ACX_WEBHOOK_SECRET || "");
  return ok;
}
export function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}
export function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405 });
}
