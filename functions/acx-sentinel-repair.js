// netlify/functions/acx-sentinel-repair.js
// ACX Sentinel Repair Loop
// - Creates an incident record in Netlify Blobs
// - Builds incident-specific reconnect links from ACX_RECONNECT_URL
// - Sends ACX house-style repair email via Mailgun
// - Uses per-inbox reconnect buttons for clear mobile UX
// - Optionally updates GHL contact custom fields

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = { "Content-Type": "application/json" };
const GHL_BASE = "https://services.leadconnectorhq.com";
const BLOBS_STORE_NAME = process.env.ACX_BLOBS_STORE || "acx-sentinel";
const FROM_EMAIL = "Automated Clarity <no-reply@mg.automatedclarity.com>";

const LOGO_URL = "https://notify.automatedclarity.com/assets/acx-logo-dark.png?v=5";
const FOOTER_LABEL = "Automated Clarity™ Monitoring";

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function safeTrunc(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function base64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseMaybeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function maskEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return "";
  const [local, domain] = clean.split("@");
  if (!local || !domain) return clean;
  if (local.length <= 2) return `${local[0] || "*"}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function severityColorFromStatus(status) {
  const s = String(status || "").toLowerCase().trim();
  if (s === "critical") return "#dc2626";
  if (s === "warning") return "#f59e0b";
  return "#2563eb";
}

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

function buildInboxList(body, fallbackEmail) {
  const parsed =
    parseMaybeJson(body.inboxes, null) ||
    parseMaybeJson(body.affected_inboxes, null) ||
    parseMaybeJson(body.monitored_inboxes, null);

  const rawList = Array.isArray(parsed) ? parsed : [];

  const normalized = rawList
    .map((item, index) => {
      if (typeof item === "string") {
        const email = normalizeEmail(item);
        if (!email) return null;
        return {
          key: email,
          label: `Inbox ${index + 1}`,
          email,
          status: "disconnected",
          grant_id: "",
          reconnected_at: "",
        };
      }

      if (item && typeof item === "object") {
        const email = normalizeEmail(
          item.email || item.address || item.key || item.inbox || item.value
        );
        if (!email) return null;

        return {
          key: email,
          label: firstNonEmpty(item.label, item.name, item.type, `Inbox ${index + 1}`),
          email,
          status: firstNonEmpty(item.status, "disconnected"),
          grant_id: firstNonEmpty(item.grant_id, item.grantId),
          reconnected_at: firstNonEmpty(item.reconnected_at, item.reconnectedAt),
        };
      }

      return null;
    })
    .filter(Boolean);

  if (normalized.length) return normalized;

  const email = normalizeEmail(
    firstNonEmpty(
      body.inbox_email,
      body.monitored_email,
      body.observed_email,
      body.email_account,
      fallbackEmail
    )
  );

  if (!email) return [];

  return [
    {
      key: email,
      label: "Primary inbox",
      email,
      status: "disconnected",
      grant_id: "",
      reconnected_at: "",
    },
  ];
}

function buildIncidentRecord(body) {
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const contactId = firstNonEmpty(body.contact_id, body.contactId, body.ghl_contact_id);
  const locationId = firstNonEmpty(
    body.location_id,
    body.locationId,
    body.ghl_location_id,
    process.env.GHL_LOCATION_ID
  );

  const contactEmail = normalizeEmail(
    firstNonEmpty(
      body.sent_to,
      body.notify_email,
      body.email,
      body.contact_email,
      body.contactEmail,
      body.recipient_email
    )
  );

  const incidentId = `acx_inc_${now.getTime()}_${crypto.randomBytes(4).toString("hex")}`;
  const token = crypto.randomBytes(24).toString("hex");
  const sentinelStatus = firstNonEmpty(body.sentinel_status, body.status, "critical");
  const grantStatus = firstNonEmpty(body.grant_status, body.connection_status, "disconnected");
  const failStreak = toInt(body.fail_streak || body.failStreak || body.fail_count, 0);
  const clientSlug = firstNonEmpty(body.client_slug, body.clientSlug);
  const contactName = firstNonEmpty(body.contact_name, body.contactName, "there");
  const companyName = firstNonEmpty(body.company_name, body.companyName, body.account_name);
  const inboxes = buildInboxList(body, contactEmail);

  return {
    incident_id: incidentId,
    token,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    contact_id: contactId,
    location_id: locationId,
    client_slug: clientSlug,
    contact_name: contactName,
    company_name: companyName,
    notify_email: contactEmail,
    sentinel_status: sentinelStatus,
    grant_status: grantStatus,
    fail_streak: failStreak,
    inboxes,
    source: {
      workflow: firstNonEmpty(body.workflow_name, body.workflow, "ACX | Sentinel | Repair Loop (v1)"),
      trigger: firstNonEmpty(body.trigger_name, body.trigger, "webhook"),
    },
    status: "open",
    repaired_at: "",
    repair_started_at: "",
  };
}

async function storeIncident(record) {
  const siteID = firstNonEmpty(process.env.NETLIFY_SITE_ID);
  const token = firstNonEmpty(process.env.NETLIFY_BLOBS_TOKEN);

  if (!siteID) throw new Error("Missing env var: NETLIFY_SITE_ID");
  if (!token) throw new Error("Missing env var: NETLIFY_BLOBS_TOKEN");

  const store = getStore({
    name: BLOBS_STORE_NAME,
    siteID,
    token,
  });

  const key = `sentinel/incidents/${record.incident_id}.json`;

  await store.set(key, JSON.stringify(record), {
    metadata: {
      type: "sentinel_reconnect_incident",
      incident_id: record.incident_id,
      contact_id: record.contact_id || "",
      location_id: record.location_id || "",
      notify_email: record.notify_email || "",
      status: record.status || "open",
    },
  });

  return key;
}

function buildReconnectUrl(record, inboxKey = "") {
  const reconnectBase = firstNonEmpty(process.env.ACX_RECONNECT_URL);
  if (!reconnectBase) throw new Error("Missing env var: ACX_RECONNECT_URL");

  const url = new URL(reconnectBase);
  url.searchParams.set("incident", record.incident_id);
  url.searchParams.set("token", record.token);

  if (inboxKey) {
    url.searchParams.set("inbox", inboxKey);
  }

  return url.toString();
}

function buildInboxStatusBlock(record) {
  const inboxes = Array.isArray(record.inboxes) ? record.inboxes : [];

  if (!inboxes.length) {
    return `
      <div style="border:1px solid #e7e7e7; border-radius:10px; padding:16px;">
        <div style="font-weight:700; margin:0 0 10px 0;">Inbox status</div>
        <div style="color:#444;">Unable to detect inboxes from this incident.</div>
      </div>
    `.trim();
  }

  const rows = inboxes
    .map((inbox, index) => {
      const status = String(inbox.status || "disconnected").toLowerCase();
      const label = inbox.label || `Inbox ${index + 1}`;
      const email = inbox.email || inbox.key || "";
      const isConnected = status === "connected";
      const reconnectUrl = buildReconnectUrl(record, inbox.key || email);

      const statusText = isConnected ? "Connected" : "Reconnect required";
      const statusColor = isConnected ? "#256c3f" : "#b42318";

      const buttonHtml = isConnected
        ? `
          <span style="display:inline-block; padding:12px 18px; background:#e6f4ea; color:#256c3f; border-radius:8px;
                       font-weight:700; border:1px solid #b7e1c2; white-space:nowrap;">
            Connected
          </span>
        `
        : `
          <a href="${escapeHtml(reconnectUrl)}"
             style="display:inline-block; padding:12px 18px; background:#0b1220; color:#ffffff; border-radius:8px;
                    text-decoration:none; font-weight:700; border:1px solid #0b1220; white-space:nowrap;">
            Reconnect
          </a>
        `;

      return `
        <tr>
          <td style="padding:16px 0; border-top:${index === 0 ? "0" : "1px solid #f0f0f0"}; vertical-align:top;">
            <div style="font-weight:700; color:#111; font-size:16px; line-height:1.35;">${escapeHtml(label)}</div>
            <div style="color:#2563eb; margin-top:6px; font-size:14px; line-height:1.45;">
              ${escapeHtml(maskEmail(email))}
            </div>
            <div style="margin-top:8px; color:${statusColor}; font-size:13px; line-height:1.4; font-weight:700;">
              ${escapeHtml(statusText)}
            </div>
          </td>
          <td style="padding:16px 0; border-top:${index === 0 ? "0" : "1px solid #f0f0f0"}; vertical-align:top; text-align:right; width:1%; white-space:nowrap;">
            ${buttonHtml}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="border:1px solid #e7e7e7; border-radius:10px; padding:16px;">
      <div style="font-weight:700; margin:0 0 8px 0; font-size:18px;">Inbox status</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        ${rows}
      </table>
    </div>
  `.trim();
}

function buildInfoBlock() {
  return `
    <div style="border:1px solid #e7e7e7; border-radius:10px; padding:18px; margin-top:10px;">
      <div style="font-weight:700; margin-bottom:10px; font-size:18px;">What happens next</div>
      <div style="color:#444; line-height:1.5; font-size:15px;">
        Use the reconnect button beside any inbox that requires attention. Each button opens your secure, incident-specific recovery flow for that inbox.
      </div>
      <div style="margin-top:10px; color:#777; font-size:12px; line-height:1.5;">
        These secure links expire automatically and are tied to this incident.
      </div>
    </div>
  `.trim();
}

function buildRepairEmailHtml({ severityColor, badge, headline, statusLine, inboxBlock, infoBlock }) {
  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charset="utf-8" />
      </head>
      <body style="margin:0; padding:0; background:#f4f6f8; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;">
        <div style="padding:24px 12px;">
          <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:14px; box-shadow:0 6px 20px rgba(0,0,0,.06); overflow:hidden;">
            <div style="height:6px; background:${escapeHtml(severityColor)};"></div>

            <div style="padding:26px;">
              <div style="margin:0 0 10px 0;">
                <span style="display:inline-block; padding:6px 10px; border-radius:999px; background:#f3f4f6; color:#111; font-size:12px; font-weight:700;">
                  ${escapeHtml(badge)}
                </span>
              </div>

              <h2 style="margin:0 0 14px 0; font-size:22px; font-weight:700; letter-spacing:-0.2px; line-height:1.15;">
                ${escapeHtml(headline)}
              </h2>

              <p style="margin:0 0 20px 0; color:#555; font-size:15px; line-height:1.5;">
                ${escapeHtml(statusLine)}
              </p>

              ${inboxBlock}

              ${infoBlock}

              ${footerBarHtml()}
            </div>
          </div>
        </div>
      </body>
    </html>
  `.trim();
}

function buildRepairEmailText({ record, statusLine }) {
  const inboxLines =
    Array.isArray(record.inboxes) && record.inboxes.length
      ? record.inboxes
          .map((i) => {
            const key = i.key || i.email || "";
            return `- ${i.label || "Inbox"}: ${i.email || i.key || ""} (${i.status || "disconnected"})\n  Reconnect: ${buildReconnectUrl(record, key)}`;
          })
          .join("\n")
      : "- Unable to detect inboxes from this incident";

  return [
    "Action needed to restore inbox protection",
    "",
    statusLine,
    "",
    "Inbox status:",
    inboxLines,
    "",
    `Incident ID: ${record.incident_id}`,
    `Status: ${record.sentinel_status} / ${record.grant_status}`,
    "",
    `— ${FOOTER_LABEL}`,
  ].join("\n");
}

async function sendMailgunEmail({ to, subject, html, text }) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;

  if (!apiKey) throw new Error("Missing MAILGUN_API_KEY");
  if (!domain) throw new Error("Missing MAILGUN_DOMAIN");
  if (!normalizeEmail(to)) throw new Error("Missing or invalid recipient email");

  const form = new URLSearchParams();
  form.set("from", FROM_EMAIL);
  form.set("to", to);
  form.set("subject", subject);
  form.set("text", text);
  form.set("html", html);

  const mgRes = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + base64(`api:${apiKey}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const mgText = await mgRes.text();

  if (!mgRes.ok) {
    throw new Error(`Mailgun send failed: ${mgRes.status} ${safeTrunc(mgText, 1200)}`);
  }

  return mgText;
}

async function updateGhlContactIfConfigured({ record }) {
  const token = firstNonEmpty(process.env.GHL_SENTINEL_TOKEN);
  if (!token || !record.contact_id) return { skipped: true };

  const customFields = [];
  const incidentFieldId = firstNonEmpty(process.env.ACX_SENTINEL_LAST_INCIDENT_CF_ID);
  const repairAtFieldId = firstNonEmpty(process.env.ACX_SENTINEL_LAST_REPAIR_AT_CF_ID);
  const statusFieldId = firstNonEmpty(process.env.ACX_SENTINEL_LAST_REPAIR_STATUS_CF_ID);

  if (incidentFieldId) {
    customFields.push({ id: incidentFieldId, field_value: record.incident_id });
  }
  if (repairAtFieldId) {
    customFields.push({ id: repairAtFieldId, field_value: record.created_at });
  }
  if (statusFieldId) {
    customFields.push({ id: statusFieldId, field_value: "sent" });
  }

  if (!customFields.length) return { skipped: true };

  const res = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(record.contact_id)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ customFields }),
  });

  const text = await res.text();

  if (!res.ok) {
    return {
      skipped: false,
      ok: false,
      status: res.status,
      body: safeTrunc(text, 1200),
    };
  }

  return {
    skipped: false,
    ok: true,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    console.log("[ACX_SENTINEL_REPAIR_IN]", JSON.stringify(body));

    const record = buildIncidentRecord(body);

    if (!record.notify_email) {
      return json(400, { ok: false, error: "missing_recipient_email" });
    }

    await storeIncident(record);

    const severityColor = severityColorFromStatus(record.sentinel_status);
    const statusWord = String(record.sentinel_status || "critical");
    const badge = `Connection issue • ${statusWord.charAt(0).toUpperCase()}${statusWord.slice(1)}`;
    const headline = "Action needed to restore inbox protection";
    const statusLine =
      "ACX Sentinel detected a disconnected email connection. Monitoring and routing protection may be reduced until the affected inboxes are reconnected.";

    const inboxBlock = buildInboxStatusBlock(record);
    const infoBlock = buildInfoBlock();
    const subject = "Action needed: reconnect your ACX protected inboxes";

    const html = buildRepairEmailHtml({
      severityColor,
      badge,
      headline,
      statusLine,
      inboxBlock,
      infoBlock,
    });

    const text = buildRepairEmailText({
      record,
      statusLine,
    });

    await sendMailgunEmail({
      to: record.notify_email,
      subject,
      html,
      text,
    });

    const ghlUpdate = await updateGhlContactIfConfigured({ record });

    console.log("ACX_SENTINEL_REPAIR_SENT", {
      contact_id: record.contact_id,
      sent_to: record.notify_email,
      sentinel_status: record.sentinel_status,
      grant_status: record.grant_status,
      fail_streak: record.fail_streak,
      incident_id: record.incident_id,
      inbox_count: Array.isArray(record.inboxes) ? record.inboxes.length : 0,
      ghl_update: ghlUpdate,
    });

    return json(200, {
      ok: true,
      sent: true,
      incident_id: record.incident_id,
      sent_to: record.notify_email,
      contact_id: record.contact_id,
      sentinel_status: record.sentinel_status,
      grant_status: record.grant_status,
      fail_streak: record.fail_streak,
      inbox_count: Array.isArray(record.inboxes) ? record.inboxes.length : 0,
    });
  } catch (err) {
    console.error("ACX_SENTINEL_REPAIR_ERROR", {
      message: err?.message,
      stack: err?.stack,
    });

    return json(500, {
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
};
