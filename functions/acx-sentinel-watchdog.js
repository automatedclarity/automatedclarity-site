// netlify/functions/acx-sentinel-watchdog.js
// TEMP DIAGNOSTIC — proves which token env var is being used

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function maskToken(token) {
  const s = String(token || "");
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

async function testRequest(path, token) {
  const base = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;

  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: getEnv("GHL_API_VERSION") || DEFAULT_API_VERSION,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {}

  return {
    ok: res.ok,
    status: res.status,
    body: parsed || text,
  };
}

exports.handler = async () => {
  try {
    const locationId = getEnv("GHL_LOCATION_ID", true);
    const sentinelToken = getEnv("GHL_SENTINEL_TOKEN", true);

    console.log("WATCHDOG_DIAG", {
      using_env: "GHL_SENTINEL_TOKEN",
      location_id: locationId,
      token_preview: maskToken(sentinelToken),
    });

    const result = await testRequest(`/contacts/?limit=1`, sentinelToken);

    console.log("WATCHDOG_DIAG_RESULT", result);

    return {
      statusCode: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: result.ok,
        using_env: "GHL_SENTINEL_TOKEN",
        location_id: locationId,
        token_preview: maskToken(sentinelToken),
        result,
      }),
    };
  } catch (err) {
    console.error("WATCHDOG_DIAG_FATAL", {
      error: err?.message || "unknown_error",
    });

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err?.message || "unknown_error",
      }),
    };
  }
};
