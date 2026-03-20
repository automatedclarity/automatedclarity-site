// netlify/functions/acx-sentinel-repair.js
// ACX Sentinel — Repair Email Loop
// Netlify is the brain:
// - receives current state from GHL webhook
// - decides whether to send
// - sends premium reconnect email via Mailgun
// - updates GHL fields only after successful send

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

// -------------------- helpers --------------------
function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function base64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: getEnv("GHL_API_VERSION") || DEFAULT_API_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function httpJson(method, url, headers, bodyObj) {
  const init = { method, headers };
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj);

  const res = await fetch(url, init);
  const text = await res.text();
  const parsed = safeJsonParse(text);
  const json = parsed.ok ? parsed.value : null;

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} calling ${url}`);
    err.status = res.status;
    err.details = json || text;
    throw err;
  }

  return json ?? {};
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return obj[k];
    }
  }
  return undefined;
}

async function ghlUpdateContact(contactId, body) {
  const base = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
  const token = getEnv("GHL_SENTINEL_TOKEN", true);

  return httpJson(
    "PUT",
    `${base}/contacts/${contactId}`,
    buildHeaders(token),
    body
  );
}

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 9999;
  return (Date.now() - d.getTime()) / 86400000;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// -------------------- email styling --------------------
const LOGO_URL = "https://notify.automatedclarity.com/assets/acx-logo-dark.png?v=5";
const FOOTER_LABEL = "Automated Clarity™ Monitoring";

function footerBarHtml() {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
      style="margin-top:14px; border-collapse:collapse; background:#0b1220; border-radius:10px;">
      <tr>
        <td style="padding:14px 16px; vertical-align:middle;">
          <img src="${escapeHtml(LOGO_URL)}"
               alt="Automated Clarity"
               width="140"
               style="display:block; border:0; outline:none; text-decoration:none; height:auto;" />
        </td>
        <td style="padding:14px 16px; vertical-align:middle; text-align:right; color:#9ca3af; font-size:12px; letter-spacing:.2px;">
          ${escapeHtml(FOOTER_LABEL)}
        </td>
      </tr>
    </table>
  `.trim();
}

function renderReconnectEmail({ reconnectUrl, companyName }) {
  const safeCompany = companyName || "your system";
  const safeReconnectUrl = escapeHtml(reconnectUrl || "");

  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charset="utf-8" />
      </head>
      <body style="margin:0; padding:0; background:#f4f6f8; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;">
        <div style="padding:24px 12px;">
          <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:14px; box-shadow:0 6px 20px rgba(0,0,0,.06); overflow:hidden;">

            <div style="height:6px; background:#f59e0b;"></div>

            <div style="padding:26px;">
              <div style="margin:0 0 10px 0;">
                <span style="display:inline-block; padding:6px 10px; border-radius:999px; background:#fef3c7; color:#92400e; font-size:12px; font-weight:700;">
                  Action Required
                </span>
              </div>

              <h2 style="margin:0 0 14px 0; font-size:22px; font-weight:700; letter-spacing:-0.2px; color:#111827;">
                Inbox connection interrupted
              </h2>

              <p style="margin:0 0 16px 0; color:#555;">
                We detected that one of your connected inboxes is no longer syncing with ${escapeHtml(safeCompany)}.
              </p>

              <p style="margin:0 0 18px 0; color:#555;">
                This usually happens after a password change, mailbox security update, or a reauthorization requirement.
              </p>

              <div style="border:1px solid #e7e7e7; border-radius:10px; padding:16px; margin-bottom:18px;">
                <div style="margin:0 0 10px 0;"><strong>Status:</strong> Connection interrupted</div>
                <div style="margin:0 0 10px 0;"><strong>Impact:</strong> New email activity may not be monitored until the inbox is reconnected</div>
                <div style="margin:0;"><strong>Action:</strong> Reconnect the inbox below to restore full operation</div>
              </div>

              <p style="margin:18px 0 14px 0; color:#111; font-weight:700;">
                Once reconnected, monitoring will resume automatically.
              </p>

              <div style="border:1px solid #e7e7e7; border-radius:10px; padding:18px; margin-top:10px;">
                <div style="font-weight:700; margin-bottom:10px;">Reconnect control</div>
                <div style="color:#444; margin-bottom:14px;">
                  Reconnect the affected inbox to restore normal system operation.
                </div>

                <a href="${safeReconnectUrl}"
                   style="display:inline-block; padding:12px 22px; background:#fff7ed; color:#9a3412; border-radius:8px;
                          text-decoration:none; font-weight:700; border:1px solid #fdba74;">
                  Reconnect inbox
                </a>

                <div style="margin-top:10px; color:#777; font-size:12px;">
                  This restores full monitoring automatically.
                </div>
              </div>

              ${footerBarHtml()}

            </div>
          </div>
        </div>
      </body>
    </html>
  `.trim();
}

async function sendMailgunEmail({ to, subject, html }) {
  const domain = getEnv("MAILGUN_DOMAIN", true);
  const apiKey = getEnv("MAILGUN_API_KEY", true);
  const fromEmail = getEnv("CLIENT_FROM_EMAIL", true);
  const fromName = getEnv("CLIENT_FROM_NAME") || "Automated Clarity";

  const form = new URLSearchParams();
  form.append("from", `${fromName} <${fromEmail}>`);
  form.append("to", to);
  form.append("subject", subject);
  form.append("html", html);

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + base64(`api:${apiKey}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Mailgun failed: ${res.status}`);
    err.details = text;
    throw err;
  }

  return text;
}

// -------------------- handler --------------------
exports.handler = async (event) => {
  try {
    const parsed = safeJsonParse(event.body || "");
    if (!parsed.ok || !parsed.value) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "invalid_json" }),
      };
    }

    const payload = parsed.value;

    const contactId = pickFirst(payload, ["contact_id"]);
    if (!contactId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "missing_contact_id" }),
      };
    }

    const reconnectUrl = getEnv("ACX_RECONNECT_URL", true);

    const sentinelStatus = normalizeKey(
      pickFirst(payload, ["acx_sentinel_status"]) || "unknown"
    );
    const grantStatus = normalizeKey(
      pickFirst(payload, ["acx_grant_status"]) || "unknown"
    );
    const failStreak = Number(
      pickFirst(payload, ["acx_fail_streak"]) || 0
    );
    const repairLastSent = pickFirst(payload, ["acx_repair_last_sent"]);
    const notifyEmail =
      pickFirst(payload, ["acx_client_notify_email"]) ||
      pickFirst(payload, ["contact_email"]);
    const companyName =
      pickFirst(payload, ["acx_company_name"]) || "your system";

    if (!notifyEmail) {
      console.log("ACX_SENTINEL_REPAIR_SKIP", {
        contact_id: contactId,
        reason: "no_notify_email",
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, skipped: "no_notify_email" }),
      };
    }

    const shouldSend =
      sentinelStatus === "critical" &&
      (grantStatus === "disconnected" || failStreak >= 3) &&
      daysSince(repairLastSent) >= 1;

    if (!shouldSend) {
      console.log("ACX_SENTINEL_REPAIR_SKIP", {
        contact_id: contactId,
        reason: "conditions_not_met",
        sentinel_status: sentinelStatus,
        grant_status: grantStatus,
        fail_streak: failStreak,
        days_since_last_sent: daysSince(repairLastSent),
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          skipped: "conditions_not_met",
          sentinel_status: sentinelStatus,
          grant_status: grantStatus,
          fail_streak: failStreak,
        }),
      };
    }

    const subject = "Action Required: Inbox Connection Interrupted";
    const html = renderReconnectEmail({
      reconnectUrl,
      companyName,
    });

    await sendMailgunEmail({
      to: notifyEmail,
      subject,
      html,
    });

    await ghlUpdateContact(contactId, {
      customFields: [
        { key: "acx_repair_last_sent", field_value: todayDateString() },
        { key: "acx_repair_status", field_value: "sent" },
      ],
    });

    console.log("ACX_SENTINEL_REPAIR_SENT", {
      contact_id: contactId,
      sent_to: notifyEmail,
      sentinel_status: sentinelStatus,
      grant_status: grantStatus,
      fail_streak: failStreak,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        sent_to: notifyEmail,
      }),
    };
  } catch (err) {
    console.error("ACX_SENTINEL_REPAIR_FATAL", {
      error: err?.message || "unknown_error",
      details: err?.details || null,
      status: err?.status || null,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err?.message || "unknown_error",
      }),
    };
  }
};
