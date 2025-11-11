import { readSession } from "./_lib/session.js";
export default async (req) => {
  const sess = readSession(req);
  if (!sess) return new Response(JSON.stringify({ ok:false }), { status:401 });
  return new Response(JSON.stringify({ ok:true }), { status:200 });
};
