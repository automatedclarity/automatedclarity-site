// Lists what the Blobs store actually contains so we can align writer vs reader.
// Call:  /.netlify/functions/acx-matrix-debug-where
import { getStore } from "@netlify/blobs";

const CANDIDATES = [
  { store: process.env.ACX_BLOBS_STORE || "acx_matrix_events", prefix: "event:" },
  { store: "acx_matrix_events", prefix: "event:" },
  { store: "acx_matrix",        prefix: "matrix:" },
  { store: "acx_matrix",        prefix: "" },
  { store: "acx_matrix_events", prefix: "" },
];

export default async () => {
  const results = {};
  for (const c of CANDIDATES) {
    try {
      const store = getStore(c.store);
      const page  = await store.list({ prefix: c.prefix, limit: 10 });
      results[`${c.store} (prefix '${c.prefix}')`] = {
        ok: true,
        count: page.blobs?.length || 0,
        sample: (page.blobs || []).map(b => ({ key: b.key, uploadedAt: b.uploadedAt }))
      };
    } catch (e) {
      results[`${c.store} (prefix '${c.prefix}')`] = { ok: false, error: String(e) };
    }
  }
  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
};
