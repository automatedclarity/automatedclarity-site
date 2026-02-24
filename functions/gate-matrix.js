import { readSession } from "./_lib/session.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DASHBOARD_PATH = join(process.cwd(), "public", "index.html");

// Change this anytime you want a hard proof you’re seeing the new deploy
const BUILD_ID = "ACX_MATRIX_INDEX_GATE_V1";

export default async (req) => {
  const sess = readSession(req);

  if (!sess.ok) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/matrix-login",
        "Cache-Control": "no-store",
        "X-ACX-Build": BUILD_ID,
      },
    });
  }

  try {
    const html = await readFile(DASHBOARD_PATH, "utf8");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-ACX-Build": BUILD_ID,
      },
    });
  } catch {
    return new Response("Dashboard missing", {
      status: 500,
      headers: { "X-ACX-Build": BUILD_ID },
    });
  }
};
