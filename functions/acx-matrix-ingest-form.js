// functions/acx-matrix-ingest-form.js
// Public browser ingest (NO ACX secret in browser)
// - Requires reCAPTCHA Enterprise token (server-verified)
// - Forwards server-side to acx-matrix-webhook with x-acx-secret + x-acx-source: ingest

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
  });

function toStr(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

// Keep numeric strings (webhook/parser can normalize)
function toNumStr(v) {
  return toStr(v);
}

// --- reCAPTCHA Enterprise assessment (server-side) ---
// Env required:
// - RECAPTCHA_ENTERPRISE_SITE_KEY (public key; used only for matching, optional)
// - RECAPTCHA_ENTERPRISE_PROJECT_ID
// - RECAPTCHA_ENTERPRISE_API_KEY   (server secret)
// Optional:
// - RECAPTCHA_MIN_SCORE (default 0.5)

async function verifyRecaptchaEnterprise({ token, expectedAction, userAgent, ip }) {
  const projectId = toStr(process.env.RECAPTCHA_ENTERPRISE_PROJECT_ID);
  const apiKey = toStr(process.env.RECAPTCHA_ENTERPRISE_API_KEY);

  if (!projectId || !apiKey) {
    // If you want to hard-require captcha, keep this as failure.
    return { ok: false, error: "Server missing reCAPTCHA Enterprise env vars" };
  }

  const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/assessments?key=${encodeURIComponent(apiKey)}`;

  const body = {
    event: {
      token,
      siteKey: toStr(process.env.RECAPTCHA_ENTERPRISE_SITE_KEY) || undefined,
      expectedAction: expectedAction || undefined,
      userAgent: userAgent || undefined,
      userIpAddress: ip || undefined,
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, error: "reCAPTCHA verify failed", detail: data };
  }

  const valid = !!data?.tokenProperties?.valid;
  const action = toStr(data?.tokenProperties?.action);
  const reason = (data?.tokenProperties?.invalidReason || "").toString();
  const score = Number(data?.riskAnalysis?.score);

  if (!valid) {
    return { ok: false, error: "reCAPTCHA token invalid", detail: { reason } };
  }
  if (expectedAction && action && action !== expectedAction) {
    return {
      ok: false,
      error: "reCAPTCHA action mismatch",
      detail: { expectedAction, action },
    };
  }

  const minScore = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
  if (Number.isFinite(score) && score < minScore) {
    return { ok: false, error: "reCAPTCHA low score", detail: { score, minScore } };
  }

  return { ok: true, score, action };
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // Expect a recaptcha token from browser
  const recaptcha_token = toStr(pick(body, ["recaptcha_token", "recaptchaToken", "token"]));
  const recaptcha_action =
    toStr(pick(body, ["recaptcha_action", "recaptchaAction", "action"])) || "matrix_ingest";

  if (!recaptcha_token) {
    return json({ ok: false, error: "Missing required field: recaptcha_token" }, 400);
  }

  // Verify captcha server-side
  const ua = req.headers.get("user-agent") || "";
  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "";

  const captcha = await verifyRecaptchaEnterprise({
    token: recaptcha_token,
    expectedAction: recaptcha_action,
    userAgent: ua,
    ip: toStr(ip).split(",")[0].trim(),
  });

  if (!captcha.ok) return json({ ok: false, error: captcha.error, detail: captcha.detail }, 401);

  // Payload fields
  const account = toStr(pick(body, ["account", "account_name", "accountName"])) || "ACX";
  const location = toStr(pick(body, ["location", "location_id", "locationId"]));
  const run_id =
    toStr(pick(body, ["run_id", "runId"])) || `run_INGEST_FORM_${Date.now()}`;

  const acx_integrity = toStr(
    pick(body, ["acx_integrity", "integrity", "integrity_status", "integrityStatus"])
  ).toLowerCase();

  const uptime = toNumStr(pick(body, ["uptime", "uptime_pct", "uptimePct"]));
  const response_ms = toNumStr(pick(body, ["response_ms", "responseMs", "response"]));
  const conversion = toNumStr(pick(body, ["conversion", "conv"]));
  const quotes_recovered = toNumStr(pick(body, ["quotes_recovered", "quotesRecovered", "quotes"]));

  if (!location) return json({ ok: false, error: "Missing required field: location" }, 400);

  // ACX secret (server-only)
  const secret = toStr(process.env.ACX_SECRET);
  if (!secret) return json({ ok: false, error: "Server missing ACX_SECRET env var" }, 500);

  // Forward to the single writer
  const origin = new URL(req.url).origin;
  const forwardUrl = `${origin}/.netlify/functions/acx-matrix-webhook`;

  const payload = {
    account,
    location,
    run_id,
    acx_integrity,
    uptime,
    response_ms,
    conversion,
    quotes_recovered,
  };

  const r = await fetch(forwardUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acx-secret": secret,
      "x-acx-source": "ingest",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let upstream = null;
  try {
    upstream = JSON.parse(text);
  } catch {
    upstream = { raw: text };
  }

  return json(
    {
      ok: r.ok,
      forwarded: true,
      captcha: { ok: true, score: captcha.score, action: captcha.action },
      upstream,
    },
    r.status
  );
};
