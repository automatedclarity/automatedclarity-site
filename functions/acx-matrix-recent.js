import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX   = "event:"; // SAME PREFIX

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 5), 500));

  const store = getStore(STORE); // positional
  const page = await store.list({ prefix: PFX, limit: 1000 });
  const blobs = (page.blobs || []).sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));
  const top = blobs.slice(0, limit);

  const events = [];
  for (const b of top) {
    const r = await store.get(b.key);
    if (!r) continue;
    try { events.push(await r.json()); } catch {}
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { "Content-Type": "application/json" }
  });
};
