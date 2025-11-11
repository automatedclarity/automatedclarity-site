import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX   = "event:"; // ← SAME PREFIX

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 5), 500));

  const store = getStore({ name: STORE });
  const page = await store.list({ prefix: PFX, limit: 1000 });
  const blobs = (page.blobs || []).sort((a,b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));
  const top = blobs.slice(0, limit);

  const events = [];
  for (const b of top) {
    try {
      const item = await store.get(b.key, { type: "json" }); // ← key fix
      if (item) events.push(item);
    } catch {}
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
};
