// Read recent Matrix events from Netlify Blobs
import { getStore } from '@netlify/blobs';

export default async (req) => {
  try {
    // auth
    const secret = req.headers.get('x-acx-secret') || '';
    if (!secret || secret !== (process.env.ACX_WEBHOOK_SECRET || '')) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }

    // parse ?limit=
    let limit = 10;
    try {
      const url = new URL(req.url);
      const raw = url.searchParams.get('limit');
      if (raw) {
        const n = Number(raw);
        if (!Number.isNaN(n) && n > 0 && n <= 100) limit = n;
      }
    } catch {}

    // get the store
    const store = getStore('acx-matrix'); // <-- THIS is the correct API
    // index is an array of ids we append to when writing
    const index = (await store.get('index', { type: 'json' })) || [];

    // take the last N ids and fetch the event docs
    const ids = index.slice(-limit).reverse();
    const events = await Promise.all(
      ids.map((id) => store.get(`e:${id}`, { type: 'json' }))
    );

    return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message, stack: String(err.stack || '') }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
};
