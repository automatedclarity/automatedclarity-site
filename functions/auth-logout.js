// functions/auth-logout.js
export default async () => {
  // expire the session cookie
  const headers = new Headers({
    "Set-Cookie": [
      // kill cookie (must exactly match name/path/samesite you set in login)
      "ACX_SESSION=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
    ],
    // send back to login
    "Location": "/matrix-login"
  ]);
  return new Response("", { status: 302, headers });
};

