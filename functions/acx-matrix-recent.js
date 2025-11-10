import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { getStore } from "./_lib/store.js";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));

  const store = getStore("matrix/logs.jsonl");
  const text = await store.read(); // JSONL
  const lines = text ? text.trim().split("\n") : [];
  const rows = lines
    .slice(-limit)                // last N
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .reverse();                   // newest first

  return new Response(
    JSON.stringify({ ok: true, count: rows.length, items: rows }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};
