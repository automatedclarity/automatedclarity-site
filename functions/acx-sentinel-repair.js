// netlify/functions/acx-sentinel-repair.js
// ACX Sentinel Repair Loop
// Creates an incident record, builds a signed reconnect link, sends premium Mailgun email,
// and optionally updates the GHL contact if token + field IDs are configured.
//
// Locked assumptions:
// - Netlify is the brain
// - GHL is trigger layer only
// - Mailgun is delivery
// - All outbound sender remains: no-reply@mg.automatedclarity.com
// - Reconnect page base/path comes from ACX_RECONNECT_URL
//
// Required env:
// - MAILGUN_API_KEY
// - MAILGUN_DOMAIN
// - ACX_RECONNECT_URL
// - NETLIFY_SITE_ID
// - NETLIFY_BLOBS_TOKEN
//
// Optional env:
// - ACX_BLOBS_STORE                (default: "acx-sentinel")
// - GHL_SENTINEL_TOKEN             (optional, only for contact update)
// - GHL_LOCATION_ID                (optional fallback)
// - ACX_SENTINEL_LAST_INCIDENT_CF_ID
// - ACX_SENTINEL_LAST_REPAIR_AT_CF_ID
// - ACX_SENTINEL_LAST_REPAIR_STATUS_CF_ID

const crypto = require("crypto");
const querystring = require("querystring");
const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const FROM_EMAIL = "no-reply@mg.automatedclarity.com";
const BLOBS_STORE_NAME = process.env.ACX_BLOBS_STORE || "acx-sentinel";
const GHL_BASE = "https://services.leadconnectorhq.com";

function json(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
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

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function maskEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return "";
  const [local, domain] = clean.split("@");
  if (!local || !domain) return clean;
  if (local.length <= 2) return `${local[0] || "*"}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function parseMaybeJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readBody(event) {
  const contentType = String(
    event.headers["content-type"] || event.headers["Content-Type"] || ""
  ).toLowerCase();

  const raw = event.body || "";
  if (!raw) return {};

  if (contentType.includes("application/json")) {
    return parseMaybeJson(raw, {});
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return querystring.parse(raw);
  }

  return parseMaybeJson(raw, {});
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

  if (!siteID) {
    throw new Error("Missing env var: NETLIFY_SITE_ID");
  }

  if (!token) {
    throw new Error("Missing env var: NETLIFY_BLOBS_TOKEN");
  }

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

function buildReconnectUrl(record) {
  const reconnectBase = firstNonEmpty(process.env.ACX_RECONNECT_URL);
  if (!reconnectBase) {
    throw new Error("Missing env var: ACX_RECONNECT_URL");
  }

  const url = new URL(reconnectBase);
  url.searchParams.set("incident", record.incident_id);
  url.searchParams.set("token", record.token);
  return url.toString();
}

function buildInboxRows(inboxes) {
  if (!Array.isArray(inboxes) || !inboxes.length) {
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">
          Unable to detect inboxes from this incident.
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#b91c1c;text-align:right;">
          Attention required
        </td>
      </tr>
    `;
  }

  return inboxes
    .map((inbox) => {
      const status = String(inbox.status || "disconnected").toLowerCase();
      const statusLabel = status === "connected" ? "Connected" : "Reconnect required";
      const statusColor = status === "connected" ? "#166534" : "#b91c1c";
      const statusBg = status === "connected" ? "#dcfce7" : "#fee2e2";

      return `
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:14px;font-weight:600;color:#111827;">${escapeHtml(
              inbox.label || "Inbox"
            )}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">${escapeHtml(
              maskEmail(inbox.email || inbox.key || "")
            )}</div>
          </td>
          <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;text-align:right;">
            <span style="display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;color:${statusColor};background:${statusBg};">
              ${statusLabel}
            </span>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildEmailHtml({ record, reconnectUrl }) {
  const contactName = escapeHtml(record.contact_name || "there");
  const companyName = escapeHtml(record.company_name || "your system");
  const failStreakLabel = escapeHtml(String(record.fail_streak || 0));
  const inboxRows = buildInboxRows(record.inboxes);

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="padding:32px 16px;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:22px;overflow:hidden;box-shadow:0 14px 40px rgba(15,23,42,0.08);">
        <div style="padding:28px 28px 18px 28px;background:linear-gradient(180deg,#0f172a 0%,#111827 100%);">
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#cbd5e1;font-weight:700;">Automated Clarity</div>
          <div style="margin-top:12px;font-size:30px;line-height:1.15;font-weight:800;color:#ffffff;">
            Action needed to restore inbox protection
          </div>
          <div style="margin-top:12px;font-size:15px;line-height:1.6;color:#cbd5e1;">
            ACX Sentinel detected a disconnected email connection. Monitoring and routing protection may be reduced until the affected inboxes are reconnected.
          </div>
        </div>

        <div style="padding:28px;">
          <div style="font-size:15px;line-height:1.7;color:#374151;">
            Hi ${contactName},
          </div>

          <div style="margin-top:14px;font-size:15px;line-height:1.8;color:#374151;">
            We detected a connection issue affecting <strong style="color:#111827;">${companyName}</strong>.
            This incident has triggered automatically after <strong style="color:#111827;">${failStreakLabel}</strong> failed recovery check(s).
          </div>

          <div style="margin-top:22px;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
            <div style="padding:14px 16px;background:#f8fafc;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#475569;">
              Inbox status
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${inboxRows}
            </table>
          </div>

          <div style="margin-top:24px;padding:18px 18px;border-radius:18px;background:#f8fafc;border:1px solid #e5e7eb;">
            <div style="font-size:14px;font-weight:700;color:#111827;">What happens next</div>
            <div style="margin-top:8px;font-size:14px;line-height:1.7;color:#475569;">
              Use the secure reconnect link below to restore the affected inboxes. This link opens your incident-specific recovery page and is not a general dashboard.
            </div>
          </div>

          <div style="margin-top:28px;text-align:center;">
            <a href="${escapeHtml(
              reconnectUrl
            )}" style="display:inline-block;padding:16px 28px;border-radius:14px;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;">
              Restore email connection
            </a>
          </div>

          <div style="margin-top:16px;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
            This secure link expires automatically and is tied to this incident.
          </div>

          <div style="margin-top:28px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.7;color:#6b7280;">
            Incident ID: ${escapeHtml(record.incident_id)}<br>
            Status: ${escapeHtml(record.sentinel_status)} / ${escapeHtml(record.grant_status)}
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
  `.trim();
}

function buildEmailText({ record, reconnectUrl }) {
  const inboxLines =
    Array.isArray(record.inboxes) && record.inboxes.length
      ? record.inboxes.map((i) => `- ${i.label}: ${i.email} (${i.status})`).join("\n")
      : "- Unable to detect inboxes from this incident";

  return [
    "Automated Clarity",
    "",
    "Action needed to restore inbox protection.",
    "",
    `Incident ID: ${record.incident_id}`,
    `Sentinel status: ${record.sentinel_status}`,
    `Grant status: ${record.grant_status}`,
    `Failed checks: ${record.fail_streak}`,
    "",
    "Affected inboxes:",
    inboxLines,
    "",
    `Reconnect now: ${reconnectUrl}`,
  ].join("\n");
}

async function sendMailgunEmail({ to, subject, html, text }) {
  const apiKey = firstNonEmpty(process.env.MAILGUN_API_KEY);
  const domain = firstNonEmpty(process.env.MAILGUN_DOMAIN);

  if (!apiKey) throw new Error("Missing env var: MAILGUN_API_KEY");
  if (!domain) throw new Error("Missing env var: MAILGUN_DOMAIN");
  if (!normalizeEmail(to)) throw new Error("Missing or invalid recipient email");

  const form = new URLSearchParams();
  form.set("from", `Automated Clarity <${FROM_EMAIL}>`);
  form.set("to", to);
  form.set("subject", subject);
  form.set("html", html);
  form.set("text", text);

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Mailgun send failed: ${res.status} ${body}`);
  }

  return body;
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
    body: JSON.stringify({
      customFields,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    return {
      skipped: false,
      ok: false,
      status: res.status,
      body: text,
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
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const body = await readBody(event);
    const record = buildIncidentRecord(body);

    if (!record.notify_email) {
      return json(400, {
        ok: false,
        error: "missing_recipient_email",
      });
    }

    await storeIncident(record);

    const reconnectUrl = buildReconnectUrl(record);
    const subject = "Action needed: reconnect your ACX protected inboxes";
    const html = buildEmailHtml({ record, reconnectUrl });
    const text = buildEmailText({ record, reconnectUrl });

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
      reconnect_url: reconnectUrl,
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
      error: err?.message || "internal_error",
    });
  }
};
