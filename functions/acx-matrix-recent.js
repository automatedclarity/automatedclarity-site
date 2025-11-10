import { Blobs } from '@netlify/blobs'

const STORE = process.env.ACX_BLOBS_STORE || 'acx-matrix'
const PFX   = 'events/'  // <- same prefix

export default async (req) => {
  // auth (unchanged)

  const url = new URL(req.url)
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 10)))

  const blobs = new Blobs({ siteID: process.env.NETLIFY_SITE_ID })

  // List keys with the SAME prefix used by the writer
  const { blobs: items } = await blobs.list({ storeName: STORE, prefix: PFX, cursor: undefined, limit: 500 })

  console.info('MATRIX_READ', { store: STORE, prefix: PFX, found: items.length }) // <— debug

  // newest first
  items.sort((a, b) => (a.key < b.key ? 1 : -1))

  const picked = items.slice(0, limit)
  const events = []
  for (const it of picked) {
    const json = await blobs.get(it.key, { storeName: STORE })
    try { events.push(JSON.parse(await json.text())) } catch {}
  }

  return new Response(JSON.stringify({ ok: true, count: events.length, events }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
