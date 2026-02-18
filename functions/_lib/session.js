// functions/_lib/session.js
// ACX Matrix session cookies (HMAC-signed, no DB)
// Exports: setSessionCookie, clearSessionCookie, readSession, requireSession

import crypto from "crypto";

const COOKIE = "acx_matrix_sess";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function unbase64url(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function getSessionKey() {
  const key = (process.env.ACX_SESSION_KEY || "").trim();
  if (!key) throw new Error("Missing required env var: ACX_SESSION_KEY");
  return key;
}

function sign(payloadJson) {
  const key = getSessionKey();
  const body = base64url(Buffer.from(payloadJson, "utf8"));
  const sig = base64url(
    crypto.createHmac("sha256", key).update(body).digest()
  );
  return `${body}.${sig}`;
}

function verify(token) {
  const key = getSessionKey();
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  const expected = base64url(
    crypto.createHmac("sha256", key).update(body).digest()
  );

  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = unbase64url(body).toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function parseCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return "";
}

export function setSessionCookie(req) {
  const now = Date.now();
  const ttlMs = 1000 * 60 * 60 * 12; // 12h
  const payload = {
    iat: now,
    exp: now + ttlMs,
    ua: (req.headers.get("user-agent") || "").slice(0, 120),
  };
  const token = sign(JSON.stringify(payload));

  // Secure cookie (Netlify is HTTPS)
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
    ttlMs / 1000
  )}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSession(req) {
  const token = parseCookie(req, COOKIE);
  if (!token) return { ok: false, reason: "missing" };

  const sess = verify(token);
  if (!sess) return { ok: false, reason: "invalid" };

  if (sess.exp && Date.now() > Number(sess.exp)) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, session: sess };
}

export function requireSession(req) {
  const s = readSession(req);
  if (!s.ok) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    };
  }
  return { ok: true, session: s.session };
}
