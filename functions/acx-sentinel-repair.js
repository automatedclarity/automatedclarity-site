// netlify/functions/acx-sentinel-repair.js
// ACX Sentinel — Repair Email Loop
// Sends premium reconnect email via Mailgun
// Updates GHL contact fields to prevent spam

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";

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

function fieldValue(contact, key) {
  const target = normalizeKey(key);

  if (
    contact &&
    contact.customFields &&
    typeof contact.customFields === "object" &&
    !Array.isArray(contact.customFields)
  ) {
    if (contact.customFields[key] !== undefined && contact.customFields[key] !== null) {
      return contact.customFields[key];
    }
    for (const [k, v] of Object.entries(contact.customFields)) {
      if (normalizeKey(k) === target) return v;
    }
  }

  if (Array.isArray(contact?.customFields)) {
    for (const field of contact.customFields) {
      const keys = [
        field?.key,
        field?.name,
        field?.fieldKey,
        field?.customFieldKey,
        field?.id,
      ];
      for (const k of keys) {
        if (normalizeKey(k) === target) {
          return field?.value ?? field?.fieldValue ?? field?.field_value ?? null;
        }
      }
    }
  }

  return undefined;
}

async function ghlGetContact(contactId) {
  const base = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
  const token = getEnv("GHL_SENTINEL_TOKEN", true);
  return httpJson(
    "GET",
    `${base}/contacts/${contactId}`,
    buildHeaders(token)
  );
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

function renderReconnectEmail({ reconnectUrl, companyName }) {
  const safeCompany = companyName || "your system";

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8eaed;">
    <div style="max-width:640px;margin:0 auto;padding:40px 24px;">
      <div style="background:#171a21;border:1px solid #2a2f3a;border-radius:18px;padding:36px;">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8b95a7;margin-bottom:18px;">
          Automated Clarity
        </div>
        <h1 style="margin:0 0 16px 0;font-size:28px;line-height:1.2;color:#ffffff;font-weight:600;">
          Inbox Connection Lost
        </h1>
        <p style="margin:0 0 16px 0;font-size:16px;line-height:1.7;color:#cfd6e4;">
          We detected that one of your connected inboxes has stopped syncing with ${safeCompany}.
        </p>
        <p style="margin:0 0 16px 0;font-size:16px;line-height:1.7;color:#cfd6e4;">
          This usually happens after a password change, security update, or mailbox reconnection requirement.
        </p>
        <p style="margin:0 0 28px 0;font-size:16px;line-height:1.7;color:#cfd6e4;">
          Reconnect the inbox below to restore normal operation. Once reconnected, your system will resume automatically.
        </p>
        <p style="margin:0 0 28px 0;">
          <a href="${reconnectUrl}" style="display:inline-block;background:#ffffff;color:#111318;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600;font-size:15px;">
            Reconnect Inbox
          </a>
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#8b95a7;">
          This was sent automatically by ACX Sentinel.
        </p>
      </div>
    </div>
  </body>
</html>
`;
}

async function sendMailgunEmail({ to, subject, html }) {
  const domain = getEnv("MAILGUN_DOMAIN", true);
  const apiKey = getEnv("MAILGUN_API_KEY", true);

  // Must remain your approved outbound sender
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
      Authorization: "Basic " + Buffer.from(`api:${apiKey}`).toString("base64"),
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

    const contactRes = await ghlGetContact(contactId);
    const contact = contactRes.contact || contactRes;

    const notifyEmail =
      fieldValue(contact, "acx_client_notify_email") ||
      contact.email;

    if (!notifyEmail) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, skipped: "no_notify_email" }),
      };
    }

    const grantStatus = normalizeKey(fieldValue(contact, "acx_grant_status") || "unknown");
    const failStreak = Number(fieldValue(contact, "acx_fail_streak") || 0);
    const repairLastSent = fieldValue(contact, "acx_repair_last_sent");
    const companyName =
      fieldValue(contact, "acx_company_name") ||
      contact.companyName ||
      contact.name ||
      "your system";

    const shouldSend =
      grantStatus === "disconnected" &&
      (daysSince(repairLastSent) >= 1 || failStreak >= 3);

    if (!shouldSend) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          skipped: "conditions_not_met",
          grant_status: grantStatus,
          fail_streak: failStreak,
        }),
      };
    }

    const subject = "Action Required: Inbox Connection Lost";
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
