// functions/gate-matrix.js
import { readSession } from "./_lib/session.js";

// Serve /public files by path
async function servePublic(path) {
  const url = new URL(`../public${path}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) return new Response("Not found", { status: 404 });
  const html = await res.text();
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default async (req) => {
  // Require valid ACX session cookie
  if (!readSession(req)) {
    return Response.redirect("/login.html", 302);
  }
  // If authenticated, return the dashboard HTML
  return servePublic("/matrix.html");
};
