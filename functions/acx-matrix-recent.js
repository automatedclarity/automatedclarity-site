// functions/acx-matrix-recent.js
import { getStore } from "@netlify/blobs";
import { requireAuth } from "./_lib/session.js";

const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix";
const KEY_PREFIX = "matrix:";
const DEFAULT_LIMIT = 100;
const MAX_SCAN = 1000;

function okJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export default async (req) => {
  if (req.method !== "GET") {
    return okJson({ ok: false, error: "Method Not Allowed" }, 405);
  }

  // Auth: allow EITHER session cookie OR x-acx-secret header
  const header = req.headers.get("x-acx-secret") || "";
  const headerOK = header && header === (process.env.ACX_WEBHOOK_SECRET || "");
  let sessionOK = false;
  try {
    // requireAuth returns a Response when NOT authed; null when authed
    sessionOK = !requireAuth(req);
  } catch {
    sessionOK = false;
  }
  if (!headerOK && !sessionOK) {
    return okJson({ ok: false, error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Number(url.searchParams.get("limit") || DEFAULT_LIMIT),
    DEFAULT_LIMIT
  );

  const store = getStore(STORE);

  // Page through list until we have enough keys (newest later, we'll sort)
  let cursor = undefined;
  const all = [];

  while (all.length < Math.min(MAX_SCAN, limit * 2)) {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: 200 });
    for (const b of page.blobs || []) all.push(b);
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Sort newest first by uploadedAt
  all.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  // Pull top N bodies
  const top = all.slice(0, limit);
  const events = [];
  for (const b of top) {
    try {
      const res = await store.get(b.key);
      if (!res) continue;
      const v = await res.json();
      events.push({
        ts: v.ts || b.uploadedAt,
        account: v.account || v.account_name || "",
        location: v.location || v.location_id || "",
        uptime: v.uptime ?? "",
        conversion: v.conversion ?? "",
        response_ms: v.response_ms ?? "",
        quotes_recovered: v.quotes_recovered ?? "",
        integrity: v.integrity || "unknown",
        run_id: v.run_id || ""
      });
    } catch {}
  }

  return okJson({ ok: true, count: events.length, events });
};
