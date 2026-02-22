// functions/_lib/matrixStore.js
// Shim for backwards-compatible imports.
// Netlify build is failing because acx-matrix-summary.js imports "./_lib/matrixStore.js"
// but your repo only has "./_lib/store.js".
export * from "./store.js";
