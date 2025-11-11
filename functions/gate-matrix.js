import { readSession } from "./_lib/session.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MATRIX_PATH = join(process.cwd(), "public", "matrix.html");

export default async (req) => {
  const sess = readSession(req);
  if (!sess) {
    return new Response(null, { status: 302, headers: { Location: "/matrix-login" } });
  }
  try {
    const html = await readFile(MATRIX_PATH, "utf8");
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    return new Response("Matrix view missing", { status: 500 });
  }
};
