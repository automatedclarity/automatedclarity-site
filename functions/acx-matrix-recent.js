import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX = "events/"; // must match writer

export default async (req) => {
  // auth (same as your other functions)
  const secret = req.headers.get("x-acx-secret") || "";
  if (!secret || secret !== (process.env.ACX_WEBHOOK_SECRET || "")) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }

  // ?limit=
  let limit = 10;
  try {
    const n = Number(new URL(req.url).searchParams.get("limit") || "");
    if (!Number.isNaN(n) && n > 0 && n <= 100) limit = n;
  } catch {}

  const store = getStore({ name: STORE });

  // list keys under the SAME prefix
  const { blobs } = await store.list({ prefix: PFX, limit: 500 });
  console.info("MATRIX_READ " + JSON.stringify({ store: STORE, found: blobs.length }));

  // newest first by key (timestamp prefix)
  blobs.sort((a, b) => (a.key < b.key ? 1 : -1));
  const pick = blobs.slice(0, limit);

  const events = [];
  for (const it of pick) {
    const res = await store.get(it.key, { type: "json" });
    if (res) events.push(res);
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { "content-type": "application/json" }
  });
};
