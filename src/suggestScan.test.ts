// The scan's recorded time is the cache's, not the moment a no-op scan answered: the server
// runs an unforced scan every TTL, and on a fresh cache that walks nothing — the scan line must
// keep saying "scanned 16h ago", not reset to "0m ago" every tick.
// Run: npx tsx src/suggestScan.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { dismissSuggestion, restoreSuggestion, type Suggestion } from "./suggest.js";
import { snapshot, startScan } from "./suggestScan.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-scan-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const cachePath = path.join(media, ".suggest-cache.json");
const row = { metrics: { matchId: 7 }, bucket: "close", score: 0.5 } as unknown as Suggestion;

try {
  // A valid cache the way the app writes one, then backdate its scan to five minutes ago —
  // inside the 30-minute TTL, so an unforced scan must return it untouched and fetch nothing.
  dismissSuggestion(7);
  restoreSuggestion(7, row);
  const cache = JSON.parse(await readFile(cachePath, "utf8")) as { scannedAt: number };
  const fiveMinAgo = Date.now() - 5 * 60_000;
  cache.scannedAt = fiveMinAgo;
  await writeFile(cachePath, JSON.stringify(cache), "utf8");

  globalThis.fetch = (async () => {
    throw new Error("a fresh cache must not touch the network");
  }) as typeof fetch;

  await startScan(false);
  const s = snapshot();
  assert.equal(s.error, null, `no error: ${s.error}`);
  assert.equal(s.result?.suggestions.length, 1, "the cached list is served");
  assert.equal(s.scannedAtMs, fiveMinAgo, "the recorded time is the cache's scan, not now");
  assert.equal(s.result?.scannedAt, fiveMinAgo, "and the result carries it too");
  console.log("suggestScan: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
