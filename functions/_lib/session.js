// Session utils for ACX Console (Netlify Functions)
// Exports: setSessionCookie, clearSessionCookie, hasSession, readSession, requireAuth

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "acx_session";
const MAX_AGE_DAYS = 7;
const MAX_AGE_SECS = MAX_AGE_DAYS * 24 * 60 * 60;

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromB64u = (str) => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function signPayload(payload, key) { return createHmac("sha256", key).update(payload).digest(); }

function makeToken(claims, key) {
  const payload = b64u(Buffer.from(JSON.stringify(claims), "utf8"));
  const mac = b64u(signPayload(payload, key));
  return `${payload}.${mac}`;
}

function verifyToken(token, key) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64u, macB64u] = token.split(".");
  let claims; try { claims = JSON.parse(fromB64u(payloadB64u).toString("utf8")); } catch { return null; }
  if (claims.exp && Date.now() > claims.exp) return null;

  const expected = signPayload(payloadB64u, key);
  const got = fromB64u(macB64u);
  if (expected.length !== got.length) return null;
  try { if (!timingSafeEqual(expected, got)) return null; } catch { return null; }
  return claims;
}

function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const p of raw.split(";").map((s) => s.trim())) {
    const i = p.indexOf("="); if (i === -1) continue;
    const k = p.slice(0, i).trim(); if (k !== name) continue;
    return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}

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

export function setSessionCookie(req) {
  const key = process.env.ACX_SESSION_KEY || "";
  if (!key) throw new Error("ACX_SESSION_KEY not set");
  const ua = req.headers.get("user-agent") || "";
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("client-ip") || "";
  const iat = Date.now();
  const exp = iat + MAX_AGE_SECS * 1000;
  const token = makeToken({ iat, exp, ua, ipHash: b64u(signPayload(ip, key)) }, key);
  return cookieHeader(COOKIENAME, token, {
    path: "/", httpOnly: true, secure: true, sameSite: "Lax",
    maxAge: MAX_AGE_SECS, expires: new Date(exp)
  });
}

// fix: COOKIE_NAME typo
const COOKIENAME = COOKIE_NAME;

export function clearSessionCookie() {
  return cookieHeader(COOKIE_NAME, "", {
    path: "/", httpOnly: true, secure: true, sameSite: "Lax",
    maxAge: 0, expires: new Date(0)
  });
}

export function readSession(req) {
  const key = process.env.ACX_SESSION_KEY || "";
  if (!key) return null;
  const token = getCookie(req, COOKIE_NAME);
  return verifyToken(token, key);
}

export function hasSession(req) { return !!readSession(req); }

export function requireAuth(req) {
  if (hasSession(req)) return null;
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}
