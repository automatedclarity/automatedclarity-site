// functions/acx-matrix-health.js
// Session-protected internal health check (dashboard-level)

import { getStore } from "@netlify/blobs";
import { requireSession } from "./_lib/session.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function readJSON(store, key) {
  try {
    const v = await store.get(key, { type: "json" });
    if (v == null) return null;
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== "GET") return json({ ok:false }, 405);

  // 🔐 session auth only
  const s = requireSession(req);
  if (!s.ok) return s.response;

  try {
    const storeName = process.env.ACX_BLOBS_STORE || "acx-matrix";
    const store = getStore({ name: storeName });

    const idx = await readJSON(store, "index:events");
    const keys = Array.isArray(idx)
      ? idx
      : (idx && Array.isArray(idx.keys) ? idx.keys : []);

    const lastKey = keys.length ? keys[keys.length - 1] : null;
    const lastEvent = lastKey ? await readJSON(store, lastKey) : null;

    return json({
      ok: true,
      store: storeName,
      index_count: keys.length,
      last_event_ts: lastEvent?.ts || null,
    });

  } catch (e) {
    return json({ ok:false, error:e?.message || "error" }, 500);
  }
};
