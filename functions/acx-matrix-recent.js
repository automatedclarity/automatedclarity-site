// Read the most recent Matrix events (protected by x-acx-secret header)

import { getStore } from "@netlify/blobs";

// Must match the writer (webhook) target
const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix_events";
const KEY_PREFIX = "event:";

// Protect with the same secret the webhook uses
function checkSecret(req) {
  const hdr = req.headers.get("x-acx-secret") || "";
  const want = process.env.ACX_WEBHOOK_SECRET || "";
  return want && hdr && hdr === want;
}

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" }
    });
  }

  if (!checkSecret(req)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min( Number(url.searchParams.get("limit") || 5), 500 ));

  const store = getStore(STORE);

  // List keys under the writer's prefix, newest first
  let cursor;
  const all = [];
  while (all.length < limit * 4) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    for (const b of page.blobs || []) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Fetch up to `limit` bodies
  const events = [];
  for (const b of all.slice(0, limit)) {
    const body = await store.get(b.key);
    if (!body) continue;
    try { events.push(await body.json()); } catch { /* ignore bad json */ }
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
};
