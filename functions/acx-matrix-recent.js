// functions/acx-matrix-recent.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix";
const KEY_PREFIX = "matrix:";

export default async (req) => {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  // ✅ Cookie/session auth
  if (!readSession(req)) return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" }
  });

  const url = new URL(req.url, "http://x");
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));

  const store = getStore(STORE);
  let cursor; const all = [];
  while (all.length < limit) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit });
    (page.blobs || []).forEach(b => all.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }
  all.sort((a,b)=> (b.uploadedAt > a.uploadedAt ? 1 : -1));

  const top = all.slice(0, limit);
  const events = [];
  for (const b of top) {
    const body = await store.get(b.key);
    if (!body) continue;
    try { events.push(await body.json()); } catch {}
  }

  return new Response(JSON.stringify({ ok:true, count: events.length, events }), {
    headers: { "Content-Type": "application/json" }
  });
};
