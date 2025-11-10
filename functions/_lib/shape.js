function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return "";
}
function toStr(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    if ("id" in v && v.id) return `${v.id}`;
    if ("name" in v && v.name) return `${v.name}`;
    if ("value" in v && v.value) return `${v.value}`;
    return "";
  }
  return `${v}`;
}

export function normalize(payload = {}) {
  const root = payload || {};
  const cd = root.customData || root.custom_data || root.custom || {};

  // GHL may literally send keys like "customData[foo]" inside customData
  const cdKey = (k) => (cd[k] !== undefined ? cd[k] : cd[`customData[${k}]`]);

  const account = toStr(
    firstDefined(
      cdKey("account_name"),
      root.account_name,
      root.account,
      root["Account Name"],
      root.location?.name
    )
  );

  const location = toStr(
    firstDefined(
      cdKey("location_id"),
      root.location_id,
      root.locationId,
      root.location?.id,
      root.location
    )
  );

  const uptime = toStr(
    firstDefined(
      cdKey("uptime"),
      root.acx_matrix_uptime,
      root.uptime,
      root["Uptime %"],
      root["ACX Matrix Uptime %"]
    )
  );

  const conversion = toStr(
    firstDefined(
      cdKey("conversion"),
      root.acx_matrix_conversion,
      root.acx_matrix_conversion_,
      root["ACX Matrix Conversion"],
      root["ACX Conversion"],
      root["Conversion %"]
    )
  );

  const response_ms = toStr(
    firstDefined(
      cdKey("response_ms"),
      cdKey("response_speed_ms"),
      cdKey("response_time_ms"),
      root.response_ms,
      root.response_speed_ms,
      root.response_time_ms,
      root["Response Speed (ms)"],
      root["ACX Matrix Response Speed (ms)`"] // observed backtick in key
    )
  );

  const quotes_recovered = toStr(
    firstDefined(
      cdKey("quotes_recovered"),
      root.quotes_recovered,
      root["Quotes Recovered"],
      root["ACX Matrix Quotes Recovered"]
    )
  );

  const integrity = toStr(
    firstDefined(
      cdKey("integrity"),
      root.integrity,
      root.integrity_status,
      root["Integrity Status"],
      root["Integrity Status (field)"],
      root["ACX Matrix Integrity Status"]
    )
  );

  const run_id = toStr(
    firstDefined(
      cdKey("run_id"),
      cdKey("test_run_id"),
      root.run_id,
      root.test_run_id,
      root["Test Run ID"],
      root["ACX Matrix Test Run ID"]
    )
  );

  return { account, location, uptime, conversion, response_ms, quotes_recovered, integrity, run_id };
}
