// netlify/functions/acx-matrix-recent.js
// Returns recent ACX Matrix / Sentinel runs for the internal console UI

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Number(limitParam || 50), 200);

  const sentinelStore = getStore("acx-sentinel-events"); // NEW canonical run log
  const legacyStore = getStore("acx-matrix-runs");       // legacy compatibility

  const runs = [];

  // ---------- SENTINEL EVENTS ----------
  try {
    const { blobs } = await sentinelStore.list();
    for (const blob of blobs) {
      const data = await sentinelStore.get(blob.key, { type: "json" });
      if (data && data.created_at) {
        runs.push(data);
      }
    }
  } catch (e) {
    console.error("matrix_recent: sentinel store read failed", e);
  }

  // ---------- LEGACY MATRIX RUNS ----------
  try {
    const { blobs } = await legacyStore.list();
    for (const blob of blobs) {
      const data = await legacyStore.get(blob.key, { type: "json" });
      if (data && data.created_at) {
        runs.push(data);
      }
    }
  } catch (e) {
    console.error("matrix_recent: legacy store read failed", e);
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
