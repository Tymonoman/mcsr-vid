// Self-check for sync.ts: the two per-clip readings settled into one placement. The detectors
// are injected — the picture reading itself is pinned in countdownDetect.test.ts, and the real
// ffmpeg decode is the pipeline's to run. Run: npx tsx src/sync.test.ts
import assert from "node:assert/strict";
import type { MatchStartDetection } from "./countdownDetect.js";
import { computeSyncOffset, fromVideo } from "./sync.js";

const seen = (matchStartSec: number, confidence = 0.8): MatchStartDetection => ({
  matchStartSec,
  confidence,
  stillRunSec: 10,
  detail: "digit for 10s with 9 steps",
});
const unseen: MatchStartDetection = {
  matchStartSec: null,
  confidence: 0,
  stillRunSec: 0,
  detail: "no countdown digit found at the centre of the frame",
};

// Both clips read: each anchored on its own evidence, confident.
{
  const r = fromVideo(seen(153.98), seen(154.23, 0.7), 150, 150);
  assert.equal(r.clipACueTimeSec, 153.98);
  assert.equal(r.clipBCueTimeSec, 154.23);
  assert.ok(r.confidence >= 0.9 && r.confidence <= 1, `both read: ${r.confidence}`);
  assert.match(r.detail, /^video: both countdowns found/);
}

// One clip read: the other keeps its coarse estimate, and the confidence says half.
{
  const r = fromVideo(unseen, seen(154.23), 150, 150);
  assert.equal(r.clipACueTimeSec, 150, "the unread clip keeps the estimate");
  assert.equal(r.clipBCueTimeSec, 154.23);
  assert.ok(r.confidence <= 0.5, `one read: ${r.confidence}`);
  assert.match(r.detail, /^video: one countdown found — countdown A not found/);
}

// A reading under the trust floor is no reading.
{
  const r = fromVideo(seen(140, 0.02), seen(154.23), 150, 150);
  assert.equal(r.clipACueTimeSec, 150);
  assert.match(r.detail, /A not found/);
}

// Neither: both estimates stand, confidence 0, and the marker says why.
{
  const r = fromVideo(unseen, unseen, 150, 147.3);
  assert.equal(r.clipACueTimeSec, 150);
  assert.equal(r.clipBCueTimeSec, 147.3);
  assert.equal(r.confidence, 0);
  assert.match(r.detail, /kept coarse estimates/);
}

// computeSyncOffset asks the detector for each clip around its own estimate.
{
  const asked: Array<[string, number, number]> = [];
  const r = await computeSyncOffset(
    "/m/a.mp4",
    "/m/b.mp4",
    150,
    147.3,
    undefined,
    async (clip, at, radius) => {
      asked.push([clip, at, radius]);
      return clip.endsWith("a.mp4") ? seen(153.98) : seen(151.1);
    },
  );
  assert.deepEqual(asked, [
    ["/m/a.mp4", 150, 25],
    ["/m/b.mp4", 147.3, 25],
  ]);
  assert.equal(r.clipACueTimeSec, 153.98);
  assert.equal(r.clipBCueTimeSec, 151.1);
}

console.log("sync: all checks passed");
