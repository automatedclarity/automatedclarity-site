import { getStore } from "@netlify/blobs";

export default async (req) => {
  const sec = req.headers.get("x-acx-secret") || "";
  if (!sec || sec !== (process.env.ACX_WEBHOOK_SECRET || "")) {
    return new Response(JSON.stringify({ ok:false, error:"Unauthorized" }), {
      status: 401, headers: { "Content-Type":"application/json" }
    });
  }
  const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
  const store = getStore({ name: STORE });
  const page = await store.list({ prefix: "", limit: 2000 });
  const keys = (page.blobs || []).map(b => b.key);
  const eventKeys = keys.filter(k => k.startsWith("event:"));
  return new Response(JSON.stringify({
    ok:true, store: STORE, total: keys.length,
    event_prefixed: eventKeys.length,
    sample_any: keys.slice(0,10),
    sample_event: eventKeys.slice(0,10)
  }), { headers: { "Content-Type":"application/json" }});
};
