function pick(fromA = {}, fromB = {}, keys = []) {
  for (const k of keys) {
    if (fromA[k] !== undefined && fromA[k] !== null && fromA[k] !== "") return fromA[k];
    if (fromB[k] !== undefined && fromB[k] !== null && fromB[k] !== "") return fromB[k];
  }
  return "";
}
export function normalize(payload = {}) {
  const cd = payload.customData || payload.custom_data || {};
  const account = pick(cd, payload, ["account","account_name"]);
  const location = pick(cd, payload, ["location","location_id"]);
  const uptime = pick(cd, payload, ["uptime","acx_matrix_uptime"]);
  const conversion = pick(cd, payload, ["conversion","acx_matrix_conversion","acx_matrix_conversion_"]);
  const response_ms = pick(cd, payload, ["response_ms","response_time_ms","response_speed_ms"]);
  const quotes_recovered = pick(cd, payload, ["quotes_recovered"]);
  const integrity = pick(cd, payload, ["integrity","integrity_status"]);
  const run_id = pick(cd, payload, ["run_id","test_run_id"]);
  return {
    account: `${account||""}`,
    location: `${location||""}`,
    uptime: `${uptime||""}`,
    conversion: `${conversion||""}`,
    response_ms: `${response_ms||""}`,
    quotes_recovered: `${quotes_recovered||""}`,
    integrity: `${integrity||""}`,
    run_id: `${run_id||""}`,
  };
}
