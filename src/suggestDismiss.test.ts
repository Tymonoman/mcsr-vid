// Dismiss and its undo, against a scratch cache. Run: npx tsx src/suggestDismiss.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { dismissSuggestion, restoreSuggestion, type Suggestion } from "./suggest.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-dismiss-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const cache = async () =>
  JSON.parse(await readFile(path.join(media, ".suggest-cache.json"), "utf8")) as {
    dismissed: number[];
    suggestions: Array<{ metrics: { matchId: number } }>;
  };
const row = { metrics: { matchId: 7 }, bucket: "close", score: 0.5 } as unknown as Suggestion;

try {
  dismissSuggestion(7);
  assert.deepEqual((await cache()).dismissed, [7], "a dismissed id is written");
  dismissSuggestion(7);
  assert.deepEqual((await cache()).dismissed, [7], "dismissing twice records it once");

  // The undo, with the row the scan module parked: back in the cache too, so a restart before
  // the next scan still shows the match.
  restoreSuggestion(7, row);
  let c = await cache();
  assert.deepEqual(c.dismissed, [], "restore un-dismisses");
  assert.deepEqual(
    c.suggestions.map((s) => s.metrics.matchId),
    [7],
    "the parked row is back in the cached list",
  );
  restoreSuggestion(7, row);
  assert.equal((await cache()).suggestions.length, 1, "restoring twice does not duplicate the row");

  // Without a row (this process never saw it) the id is simply no longer excluded; the next scan
  // scores it again.
  dismissSuggestion(9);
  restoreSuggestion(9);
  c = await cache();
  assert.deepEqual(c.dismissed, [], "restore without a row still un-dismisses");
  assert.ok(!c.suggestions.some((s) => s.metrics.matchId === 9), "and invents no row");
  console.log("suggestDismiss: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
