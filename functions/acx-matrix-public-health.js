// functions/acx-matrix-public-health.js
// Sentinel-safe health check (NO metrics exposed)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function authOk(req) {
  const expected = (process.env.ACX_WEBHOOK_SECRET || "").trim();
  const got = (req.headers.get("x-acx-secret") || "").trim();
  return !!expected && got === expected;
}

export default async (req) => {
  if (req.method !== "GET") return json({ ok:false }, 405);

  // 🔐 secret header only
  if (!authOk(req)) return json({ ok:false }, 401);

  return json({ ok:true });
};
