// functions/_lib/matrixStore.js
// Compatibility layer for older imports used by acx-matrix-summary.js.
// Your repo has functions/_lib/store.js, but it does NOT export:
//   storeGetRecent, storeGetLocations, storeGetSeries
// So we map those names to whatever your store.js actually exports.

import * as S from "./store.js";

function pick(fnLabel, candidates) {
  for (const name of candidates) {
    if (typeof S[name] === "function") return S[name];
  }
  throw new Error(
    `matrixStore.js missing function "${fnLabel}". Tried: ${candidates.join(
      ", "
    )}. Check functions/_lib/store.js exports.`
  );
}

export async function storeGetRecent(...args) {
  const fn = pick("storeGetRecent", [
    "storeGetRecent",
    "getRecent",
    "get_recent",
    "getMatrixRecent",
    "matrixGetRecent",
    "store_recent",
  ]);
  return fn(...args);
}

export async function storeGetLocations(...args) {
  const fn = pick("storeGetLocations", [
    "storeGetLocations",
    "getLocations",
    "get_locations",
    "getMatrixLocations",
    "matrixGetLocations",
    "store_locations",
  ]);
  return fn(...args);
}

export async function storeGetSeries(...args) {
  const fn = pick("storeGetSeries", [
    "storeGetSeries",
    "getSeries",
    "get_series",
    "getMatrixSeries",
    "matrixGetSeries",
    "store_series",
  ]);
  return fn(...args);
}

// Optional: pass-through any other exports in case other files import them.
export * from "./store.js";
