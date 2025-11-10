// functions/_lib/session.js
import crypto from "node:crypto";

const COOKIE_NAME = "acx_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(iat, key) {
  const h = crypto.createHmac("sha256", key);
  h.update(String(iat));
  return b64url(h.digest());
}

export function makeSessionCookie(key) {
  const iat = Math.floor(Date.now() / 1000);
  const sig = sign(iat, key);
  const val = `${iat}.${sig}`;
  return `${COOKIE_NAME}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function verifySessionCookie(req, key) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!m) return false;

  const [iatStr, sig] = m[1].split(".");
  if (!iatStr || !sig) return false;

  const expected = sign(iatStr, key);
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return false;

  const iat = parseInt(iatStr, 10) || 0;
  const age = Math.floor(Date.now() / 1000) - iat;
  return age >= 0 && age <= MAX_AGE_SECONDS;
}

// Guard you can use inside functions
export function requireAuth(req) {
  const KEY = process.env.ACX_SESSION_KEY || "";
  if (!verifySessionCookie(req, KEY)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null; // authorized
}
