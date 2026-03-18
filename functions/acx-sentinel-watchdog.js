// netlify/functions/acx-sentinel-watchdog.js
// ACX Sentinel — Signal Watchdog (5-min loop)

const DEFAULT_API_BASE = "https://services.leadconnectorhq.com";

function getEnv(name, required = false) {
  const v = process.env[name];
  if (required && (!v || !String(v).trim())) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

async function ghlRequest(path) {
  const base = getEnv("GHL_API_BASE") || DEFAULT_API_BASE;
  const token = getEnv("GHL_LOCATION_TOKEN", true);

  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: getEnv("GHL_API_VERSION") || "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`GHL request failed: ${res.status}`);
  }

  return res.json();
}

async function postSentinel(payload) {
  const url = "https://console.automatedclarity.com/.netlify/functions/acx-sentinel-webhook";

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

exports.handler = async () => {
  try {
    const locationId = getEnv("GHL_LOCATION_ID", true);

    // Get contacts (limit to ACX accounts if needed later)
    const data = await ghlRequest(`/contacts/?locationId=${locationId}`);

    const contacts = data.contacts || [];

    const now = Date.now();

    for (const c of contacts) {
      const lastEvent = c.customFields?.acx_last_event_at;

      const maxGap = Number(
        c.customFields?.acx_signal_expected_max_gap_minutes || 30
      );

      let fail = false;

      if (!lastEvent) {
        fail = true;
      } else {
        const last = new Date(lastEvent).getTime();
        const diffMinutes = (now - last) / 60000;

        if (diffMinutes > maxGap) {
          fail = true;
        }
      }

      if (fail) {
        await postSentinel({
          contact_id: c.id,
          location_id: locationId,
          status: "critical",
          fail_streak: Number(c.customFields?.acx_fail_streak || 0) + 1,
        });
      } else {
        await postSentinel({
          contact_id: c.id,
          location_id: locationId,
          status: "optimal",
          fail_streak: 0,
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
