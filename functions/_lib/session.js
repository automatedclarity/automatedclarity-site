// functions/_lib/session.js
// ACX Matrix session helpers (ESM) — cookie-based, HMAC-signed
// Requires env var: ACX_SESSION_KEY
//
// Exports:
// - setSessionCookie(req)
// - clearSessionCookie()
// - requireSession(req)  -> Response if unauthorized, null if ok
// - readSession(req)     -> { ok, session?, reason? }

const COOKIE_NAME = "acx_session";
const ONE_DAY = 60 * 60 * 24;

function getEnv(name) {
  return (process.env[name] || "").trim();
}

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

async function hmacSHA256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "utf8"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, Buffer.from(message, "utf8"));
  return base64urlEncode(sig);
}

function parseCookies(req) {
  const header = req.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function buildCookie(value, { maxAgeSeconds, clear = false } = {}) {
  const parts = [];
  parts.push(`${COOKIE_NAME}=${encodeURIComponent(value || "")}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Strict");
  parts.push("Secure"); // Matrix is HTTPS only

  if (clear) {
    parts.push("Max-Age=0");
  } else if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  return parts.join("; ");
}

async function makeToken(req) {
  const secret = getEnv("ACX_SESSION_KEY");
  if (!secret) throw new Error("Missing env var: ACX_SESSION_KEY");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + ONE_DAY;

  // Stable fingerprint for basic replay resistance
  const ua = (req.headers.get("user-agent") || "").slice(0, 120);
  const ip =
    (req.headers.get("x-nf-client-connection-ip") ||
      req.headers.get("x-forwarded-for") ||
      "")
      .split(",")[0]
      .trim()
      .slice(0, 64);

  const payloadObj = { v: 1, iat: now, exp, ua, ip };
  const payload = base64urlEncode(JSON.stringify(payloadObj));

  const sig = await hmacSHA256(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(req, token) {
  const secret = getEnv("ACX_SESSION_KEY");
  if (!secret) return { ok: false, reason: "server-not-configured" };

  const parts = String(token || "").split(".");
  if (parts.length !== 2) return { ok: false, reason: "bad-token-format" };

  const [payload, sig] = parts;

  const expected = await hmacSHA256(secret, payload);
  if (sig !== expected) return { ok: false, reason: "bad-signature" };

  let obj = null;
  try {
    obj = JSON.parse(base64urlDecode(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!obj?.exp || now > obj.exp) return { ok: false, reason: "expired" };

  // Optional replay checks
  const ua = (req.headers.get("user-agent") || "").slice(0, 120);
  const ip =
    (req.headers.get("x-nf-client-connection-ip") ||
      req.headers.get("x-forwarded-for") ||
      "")
      .split(",")[0]
      .trim()
      .slice(0, 64);

  if ((obj.ua || "") !== ua) return { ok: false, reason: "ua-mismatch" };
  if ((obj.ip || "") !== ip) return { ok: false, reason: "ip-mismatch" };

  return { ok: true, session: obj };
}

// ---- PUBLIC EXPORTS ----

export async function setSessionCookie(req) {
  const token = await makeToken(req);
  return buildCookie(token, { maxAgeSeconds: ONE_DAY });
}

export function clearSessionCookie() {
  return buildCookie("", { clear: true });
}

// Returns { ok: true, session } or { ok:false, reason }
export async function readSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  return await verifyToken(req, token);
}

// Returns a Response when unauthorized; returns null when authorized
export async function requireSession(req) {
  const v = await readSession(req);

  if (!v.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized", reason: v.reason }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  return null;
}
