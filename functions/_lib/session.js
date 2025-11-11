// functions/_lib/session.js
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "acx_session";
const MAX_AGE_DAYS = 7; // session length
const MAX_AGE_SECS = MAX_AGE_DAYS * 24 * 60 * 60;

// Base64url helpers
const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromB64u = (str) =>
  Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// HMAC-SHA256(signingKey, payload)
function signPayload(payload, key) {
  return createHmac("sha256", key).update(payload).digest();
}

// Build a compact token: base64url(json) + "." + base64url(hmac)
function makeToken(claims, key) {
  const payload = b64u(Buffer.from(JSON.stringify(claims), "utf8"));
  const mac = b64u(signPayload(payload, key));
  return `${payload}.${mac}`;
}

function verifyToken(token, key) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64u, macB64u] = token.split(".");
  let claims;
  try {
    claims = JSON.parse(fromB64u(payloadB64u).toString("utf8"));
  } catch {
    return null;
  }
  // Expiry check (optional but recommended)
  if (claims.exp && Date.now() > claims.exp) return null;

  const expected = signPayload(payloadB64u, key);
  const got = fromB64u(macB64u);
  if (expected.length !== got.length) return null;
  try {
    if (!timingSafeEqual(expected, got)) return null;
  } catch {
    return null;
  }
  return claims;
}

// Parse cookies from Request
function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const parts = raw.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

// Build Set-Cookie strings
function cookieHeader(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  return parts.join("; ");
}

// === Public API ===

// Returns a Set-Cookie string that sets a valid session
export function setSessionCookie(req) {
  const key = process.env.ACX_SESSION_KEY || "";
  if (!key) throw new Error("ACX_SESSION_KEY not set");
  const ua = req.headers.get("user-agent") || "";
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("client-ip") || "";
  const iat = Date.now();
  const exp = iat + MAX_AGE_SECS * 1000;

  const token = makeToken({ iat, exp, ua, ipHash: b64u(signPayload(ip, key)) }, key);
  return cookieHeader(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: MAX_AGE_SECS,
    expires: new Date(exp),
  });
}

// Returns a Set-Cookie string that clears the session
export function clearSessionCookie() {
  return cookieHeader(COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 0,
    expires: new Date(0),
  });
}

// Boolean: is there a valid session?
export function hasSession(req) {
  const key = process.env.ACX_SESSION_KEY || "";
  if (!key) return false;
  const token = getCookie(req, COOKIE_NAME);
  const claims = verifyToken(token, key);
  if (!claims) return false;

  // Optional UA bind for a little extra safety (soft check)
  const ua = req.headers.get("user-agent") || "";
  if (claims.ua && ua && claims.ua.slice(0, 16) !== ua.slice(0, 16)) {
    // UA changed dramatically — still allow, or flip to false if you prefer stricter binding
    return true;
  }
  return true;
}

// Gate: returns null if authed; returns a 401 Response if not
export function requireAuth(req) {
  if (hasSession(req)) return null;
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
