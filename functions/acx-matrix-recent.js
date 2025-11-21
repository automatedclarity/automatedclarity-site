// netlify/functions/acx-matrix-recent.js
// Returns recent ACX Matrix runs for the internal console UI

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Number(limitParam || 50), 200); // cap to 200

  const store = getStore("acx-matrix-runs");

  // List all blob keys in this store
  const { blobs } = await store.list();

  // Load each run as JSON
  const runs = [];
  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: "json" });
    if (data && data.created_at) {
      runs.push(data);
    }
  }

  // Sort newest first
  runs.sort((a, b) => {
    if (!a.created_at || !b.created_at) return 0;
    return a.created_at > b.created_at ? -1 : 1;
  });

  const sliced = runs.slice(0, limit);

  return new Response(JSON.stringify({ runs: sliced }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
