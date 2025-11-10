import crypto from "node:crypto";

const NAME = "ACX_DASH_SESSION";
const MAX_AGE = 60 * 60 * 24 * 30; // 30d

export function cookieName(){ return NAME; }

function sign(payload, key){
  const h = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${h}`;
}
function verify(token, key){
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
}

export function setCookie(value){
  return [
    `${NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE}`
  ].join("; ");
}
export function clearCookie(){
  return [`${NAME}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ");
}
export function createSession(sub){
  const exp = Math.floor(Date.now()/1000) + MAX_AGE;
  const payload = Buffer.from(JSON.stringify({ sub, exp }), "utf8").toString("base64url");
  return sign(payload, process.env.ACX_SESSION_KEY || "");
}
export function readSession(req){
  const key = process.env.ACX_SESSION_KEY || "";
  const cookie = (req.headers.get("cookie")||"").split(/;\s*/).find(c=>c.startsWith(`${NAME}=`));
  if (!cookie) return null;
  const token = cookie.slice(NAME.length+1);
  const data = verify(token, key);
  if (!data) return null;
  if (data.exp && data.exp < Math.floor(Date.now()/1000)) return null;
  return data;
}
