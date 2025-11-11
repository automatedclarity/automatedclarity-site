// functions/acx-matrix-debug-where.js
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

// Quick inspector to see where events are stored
export default async (req) => {
  // Require logged-in session (same as dashboard)
  if (!readSession(req)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const storesToCheck = [
    { name: "acx_matrix", prefix: "matrix:" },
    { name: "acx_matrix", prefix: "" },
    { name: "acx_matrix_events", prefix: "" },
  ];

  const results = {};
  for (const s of storesToCheck) {
    try {
      const store = getStore(s.name);
      const opts = { limit: 50 };
      if (s.prefix) opts.prefix = s.prefix;
      const page = await store.list(opts);
      results[`${s.name} (prefix '${s.prefix}')`] = {
        ok: true,
        count: (page.blobs || []).length,
        sample: (page.blobs || []).slice(0, 5).map(b => ({
          key: b.key,
          uploadedAt: b.uploadedAt
        }))
      };
    } catch (e) {
      results[`${s.name} (prefix '${s.prefix}')`] = {
        ok: false,
        error: String(e && e.message || e)
      };
    }
  }

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
};
