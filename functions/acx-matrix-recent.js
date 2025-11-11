// functions/acx-matrix-recent.js
import { checkAuth } from "./_lib/auth.js";
import { readSession } from "./_lib/session.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx_matrix_events"; // <— must match writer
const PFX   = "event:";                                           // <— must match writer
const DEFAULT_LIMIT = 5;

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok:false, error:"Method Not Allowed" }), { status: 405 });
  }

  // Allow either header secret OR session cookie
  const authed =
    checkAuth(req) ||
    (() => { try { return !!readSession(req); } catch { return false; } })();

  if (!authed) {
    return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || DEFAULT_LIMIT), 100);

  const store = getStore(STORE);
  // list newest-ish (we’ll sort after)
  const page = await store.list({ prefix: PFX, limit: 500 }); // pull a page
  const blobs = (page.blobs || []).slice(); // copy

  // Sort by uploadedAt desc if available, else by key desc
  blobs.sort((a, b) => {
    const au = a.uploadedAt || "";
    const bu = b.uploadedAt || "";
    if (au && bu) return bu.localeCompare(au);
    return b.key.localeCompare(a.key);
  });

  const top = blobs.slice(0, limit);
  const events = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      const item = await res.json();
      events.push({
        ts: item.ts || null,
        account: item.account || item.account_name || "",
        location: item.location || item.location_id || "",
        uptime: item.uptime ?? "",
        conversion: item.conversion ?? "",
        response_ms: item.response_ms ?? "",
        quotes_recovered: item.quotes_recovered ?? "",
        integrity: item.integrity || "unknown",
        run_id: item.run_id || ""
      });
    } catch {}
  }

  return new Response(JSON.stringify({ ok:true, count: events.length, events }), {
    headers: { "Content-Type": "application/json" }
  });
};
