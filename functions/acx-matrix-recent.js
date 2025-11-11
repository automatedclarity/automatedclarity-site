// ACX Matrix — Reader (recent rows)
// Lists recent events from the same Blobs store/prefix
import { getStore } from "@netlify/blobs";

const STORE  = "acx_matrix_events";  // <- forced match
const PREFIX = "event:";             // <- forced match
const MAX_SCAN = 2000;

function num(v, d = "") {
  if (v === "" || v === null || v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export default async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(+(url.searchParams.get("limit") || 100), 1000));

  const store = getStore(STORE);

  // page through blobs (prefix) up to MAX_SCAN, sort by uploadedAt desc
  let cursor; const blobs = [];
  while (blobs.length < MAX_SCAN) {
    const page = await store.list({ prefix: PREFIX, cursor, limit: 200 });
    (page.blobs || []).forEach(b => blobs.push(b));
    cursor = page.cursor;
    if (!cursor) break;
  }
  blobs.sort((a, b) => (b.uploadedAt > a.uploadedAt ? 1 : -1));

  const top = blobs.slice(0, limit);
  const events = [];
  for (const b of top) {
    const res = await store.get(b.key);
    if (!res) continue;
    try {
      const e = await res.json();
      events.push({
        ts: e.ts || b.uploadedAt,
        account: e.account || "",
        location: e.location || "",
        uptime: num(e.uptime, ""),
        conversion: num(e.conversion, ""),
        response_ms: num(e.response_ms, ""),
        quotes_recovered: num(e.quotes_recovered, ""),
        integrity: (e.integrity || "unknown").toLowerCase(),
        run_id: e.run_id || "",
      });
    } catch {}
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { "Content-Type": "application/json" },
  });
};
