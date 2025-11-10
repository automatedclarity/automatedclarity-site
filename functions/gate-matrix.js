// functions/gate-matrix.js
import { requireAuth } from "./_lib/session.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PUBLIC_MATRIX = resolve(process.cwd(), "public", "matrix.html");

export default async (req) => {
  // If no valid cookie, bounce to login
  const guard = requireAuth(req);
  if (guard) {
    return new Response("", { status: 302, headers: { Location: "/matrix-login" } });
  }

  // Serve your existing public/matrix.html
  try {
    const html = await readFile(PUBLIC_MATRIX, "utf8");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return new Response("Matrix view missing", { status: 500 });
  }
};
