function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return "";
}
function toStr(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    // common GHL shapes like { id, name } or { value }
    if ("id" in v && v.id !== undefined && v.id !== null && v.id !== "") return `${v.id}`;
    if ("name" in v && v.name !== undefined && v.name !== null && v.name !== "") return `${v.name}`;
    if ("value" in v && v.value !== undefined && v.value !== null && v.value !== "") return `${v.value}`;
    return ""; // avoid "[object Object]" noise
  }
  return `${v}`;
}

export function normalize(payload = {}) {
  const root = payload || {};
  const cd = root.customData || root.custom_data || root.custom || {};

  const account = toStr(firstDefined(
    cd.account_name, cd.account, root.account_name, root.account,
    root.location?.name
  ));

  const location = toStr(firstDefined(
    cd.location_id, root.location_id, root.locationId,
    root.location?.id, root.location
  ));

  const uptime = toStr(firstDefined(
    cd.uptime, cd.acx_matrix_uptime, root.acx_matrix_uptime, root.uptime
  ));

  const conversion = toStr(firstDefined(
    cd.conversion, cd.acx_matrix_conversion, cd.acx_matrix_conversion_,
    root.acx_matrix_conversion, root.acx_matrix_conversion_, root.conversion
  ));

  const response_ms = toStr(firstDefined(
    cd.response_ms, cd.response_speed_ms, cd.response_time_ms,
    root.response_ms, root.response_speed_ms, root.response_time_ms
  ));

  const quotes_recovered = toStr(firstDefined(
    cd.quotes_recovered, root.quotes_recovered
  ));

  const integrity = toStr(firstDefined(
    cd.integrity, cd.integrity_status, root.integrity, root.integrity_status
  ));

  const run_id = toStr(firstDefined(
    cd.run_id, cd.test_run_id, root.run_id, root.test_run_id
  ));

  return { account, location, uptime, conversion, response_ms, quotes_recovered, integrity, run_id };
}
