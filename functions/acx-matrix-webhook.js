// netlify/functions/acx-matrix-webhook.js
// ACX Matrix — Event Writer (matches acx-matrix-summary reader)
// - Auth: x-acx-secret (via ./_lib/auth.js)
// - Store: process.env.ACX_BLOBS_STORE || "acx-matrix"
// - Key prefix: "event:"  (MUST match reader)
// - Writes JSON blobs that acx-matrix-summary can list/aggregate

import { checkAuth, unauthorized, methodNotAllowed } from "./_lib/auth.js";
import { getStore } from "@netlify/blobs";

const STORE = process.env.ACX_BLOBS_STORE || "acx-matrix";
const PFX = "event:";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const toNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed();
  if (!checkAuth(req)) return unauthorized();

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  // Accept both "flat" payload and nested payloads
  const ts = body.ts || body.created_at || new Date().toISOString();
  const run_id = body.run_id || body.runId || `run-${Date.now()}`;

  const account =
    body.account ||
    body.account_name ||
    body.accountName ||
    body?.matrix?.account ||
    "unknown";

  const location =
    body.location ||
    body.location_id ||
    body.locationId ||
    body?.matrix?.location ||
    "unknown";

  const uptime = body.uptime ?? body?.matrix?.uptime ?? 0;
  const conversion = body.conversion ?? body?.matrix?.conversion ?? 0;
  const response_ms =
    body.response_ms ??
    body.responseMs ??
    body?.matrix?.response_ms ??
    body?.matrix?.responseMs ??
    0;

  const quotes_recovered =
    body.quotes_recovered ??
    body.quotesRecovered ??
    body?.matrix?.quotes_recovered ??
    body?.matrix?.quotesRecovered ??
    0;

  const integrity =
    body.integrity ||
    body?.matrix?.integrity ||
    "unknown";

  // This object shape is what acx-matrix-summary expects
  const event = {
    ts: String(ts),
    run_id: String(run_id),
    account: String(account),
    location: String(location),
    uptime: toNum(uptime, 0),
    conversion: toNum(conversion, 0),
    response_ms: toNum(response_ms, 0),
    quotes_recovered: toNum(quotes_recovered, 0),
    integrity: String(integrity).toLowerCase(),
  };

  if (!event.location || event.location === "unknown") {
    return json(400, { ok: false, error: "Missing location (location/location_id)" });
  }

  const store = getStore({ name: STORE });

  // Key MUST start with "event:" so acx-matrix-summary sees it
  const key = `${PFX}${event.location}:${event.run_id}:${Date.now()}`;

  try {
    await store.setJSON(key, event);
    console.info("MATRIX_EVENT_WRITTEN", { store: STORE, key });
  } catch (e) {
    console.error("MATRIX_EVENT_WRITE_FAILED", e);
    return json(500, { ok: false, error: "Failed to write Matrix event" });
  }

  return json(200, { ok: true, written_key: key, store: STORE, event });
};
