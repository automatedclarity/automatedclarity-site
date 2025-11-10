// Minimal blob-backed JSONL store for Matrix/Sentinel
import { blobs } from "@netlify/blobs";

export function getStore(key = "matrix/logs.jsonl") {
  const b = blobs;
  return {
    async append(line) {
      const existing = (await b.get(key)) || "";
      await b.set(key, existing + line);
    },
    async read() {
      return (await b.get(key)) || "";
    }
  };
}
