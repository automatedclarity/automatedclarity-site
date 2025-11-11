// functions/gate-matrix.js
import { readSession } from "./_lib/session.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MATRIX_PATH = join(process.cwd(), "public", "matrix.html");

export default async (req) => {
  // Require a valid session cookie; otherwise bounce to login
  const sess = readSession(req);
  if (!sess) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/matrix-login" }, // static login page or your gated login route
    });
  }

  // Serve the dashboard HTML directly from /public
  try {
    const html = await readFile(MATRIX_PATH, "utf8");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response("Matrix view missing", { status: 500 });
  }
};
