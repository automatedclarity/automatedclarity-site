// functions/acx-matrix-debug-where.js
import { getStore } from "@netlify/blobs";
import { requireAuth } from "./_lib/session.js";

async function probe(storeName, prefix = "", max = 20) {
  const store = getStore(storeName);
  let cursor, keys = [];
  try {
    do {
      const page = await store.list({ cursor, prefix, limit: max });
      (page.blobs || []).forEach(b => keys.push({ key: b.key, uploadedAt: b.uploadedAt }));
      cursor = page.cursor;
      if (!cursor || keys.length >= max) break;
    } while (true);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: true, count: keys.length, sample: keys.slice(-max) };
}

export default async (req) => {
  const guard = requireAuth(req);
  if (guard) return new Response("Unauthorized", { status: 401 });

  const checks = [
    { name: "acx_matrix (prefix 'matrix:')", store: "acx_matrix", prefix: "matrix:" },
    { name: "acx_matrix (no prefix)",         store: "acx_matrix", prefix: "" },
    { name: "acx_matrix_events (no prefix)",  store: "acx_matrix_events", prefix: "" },
  ];

  const results = {};
  for (const c of checks) {
    results[c.name] = await probe(c.store, c.prefix, 25);
  }

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
};
