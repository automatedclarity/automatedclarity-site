import { Blobs } from '@netlify/blobs'

const STORE = process.env.ACX_BLOBS_STORE || 'acx-matrix'
const PFX   = 'events/'  // <- shared prefix

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  // auth (unchanged)
  // ... your existing checkAuth/unauthorized calls ...

  let body = {}; try { body = await req.json(); } catch {}
  const cd = body.customData || body || {}

  const event = {
    account: cd.account_name || '',
    location: cd.location_id || '',
    uptime: cd.uptime || '',
    conversion: cd.conversion || '',
    response_ms: cd.response_ms || '',
    quotes_recovered: cd.quotes_recovered || '',
    integrity: cd.integrity || '',
    run_id: cd.run_id || '',
    ts: new Date().toISOString()
  }

  const blobs = new Blobs({ siteID: process.env.NETLIFY_SITE_ID })
  const key = `${PFX}${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  await blobs.set(key, JSON.stringify(event), { storeName: STORE, contentType: 'application/json' })

  console.info('MATRIX_WRITE', { store: STORE, prefix: PFX, key }) // <— debug

  return new Response(JSON.stringify({ ok: true, message: 'Matrix data received' }), {
    headers: { 'Content-Type': 'application/json' }
  })
}
