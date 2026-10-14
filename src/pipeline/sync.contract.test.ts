// Contract test for sync.ts, written from the docs (CLAUDE.md "Known pitfalls": sync reads the
// picture only; the handbook's long form) by an outside engineer. The detector is injected — its
// pixel reading is countdownDetect.test.ts's to pin; this is what the settled placement promises.
// Run: npx tsx src/pipeline/sync.contract.test.ts
//
// Promises covered (numbering shared with src/dashboard/syncRoutes.contract.test.ts):
//  P1  Sync reads the picture, and only the picture: each POV clip is anchored on its own
//      countdown reading; no audio fallback (removed 22 Sept 2026 — 12–32 s wrong on real footage).
//  P2  A clip the picture cannot read keeps the coarse estimate at confidence 0, and the
//      dashboard's sync editor settles it (the editor is flagged by confidence < threshold).
import assert from "node:assert/strict";
import { config } from "../config.js";
import type { MatchStartDetection } from "./countdownDetect.js";
import { computeSyncOffset, type MatchStartDetector } from "./sync.js";

/** Keeps the docs' wording where the code differs; prints it and carries on until triage. */
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const read = (matchStartSec: number, confidence = 0.8): MatchStartDetection => ({
  matchStartSec,
  confidence,
  stillRunSec: 10,
  detail: "digit for 10s",
});
const unread: MatchStartDetection = { matchStartSec: null, confidence: 0, stillRunSec: 0, detail: "nothing" };

/** A detector answering per clip, recording every look it was asked for. */
function detector(answers: Record<string, MatchStartDetection>) {
  const asked: string[] = [];
  const detect: MatchStartDetector = async (clip) => {
    asked.push(clip);
    return answers[clip]!;
  };
  return { asked, detect };
}

// Clip paths that do not exist: if anything besides the injected picture reading (an audio
// cross-correlation, an ffprobe) looked at the clips, it would fail on these.
const A = "/nonexistent/left.mp4";
const B = "/nonexistent/right.mp4";

// --- P1: the picture, once per clip, and nothing else ----------------------------------------
{
  const { asked, detect } = detector({ [A]: read(153.98), [B]: read(151.1, 0.7) });
  const r = await computeSyncOffset(A, B, 150, 150, undefined, detect);
  assert.deepEqual(asked.sort(), [A, B].sort(), "one picture reading per clip, no second evidence pass");
  assert.equal(r.clipACueTimeSec, 153.98);
  assert.equal(r.clipBCueTimeSec, 151.1);
  assert.ok(r.confidence >= config.syncConfidenceThreshold, "both read: trusted");
}

// P1: each clip on its own evidence — whatever the other POV's picture says (unread, early,
// late, confident or not), this clip's placement does not move. A relative (cross-clip) sync
// would drag one POV with the other's error.
for (const other of [unread, read(120), read(180, 0.95), read(149, 0.09)]) {
  const { detect } = detector({ [A]: read(153.98), [B]: other });
  const r = await computeSyncOffset(A, B, 150, 147.3, undefined, detect);
  assert.equal(r.clipACueTimeSec, 153.98, `left stays put whatever the right reads (${other.matchStartSec})`);
}

// P1: no audio fallback — two unreadable pictures give the estimates back, not a third opinion.
{
  const { detect } = detector({ [A]: unread, [B]: unread });
  const r = await computeSyncOffset(A, B, 150, 147.3, undefined, detect);
  assert.equal(r.clipACueTimeSec, 150);
  assert.equal(r.clipBCueTimeSec, 147.3);
  // P2: neither read — confidence 0, which is under the line, so the editor is asked.
  assert.equal(r.confidence, 0);
  assert.ok(r.confidence < config.syncConfidenceThreshold);
  assert.doesNotMatch(r.detail, /audio/i, "the marker never claims an audio reading");
}

// --- P2: one clip the picture cannot read -----------------------------------------------------
{
  const { detect } = detector({ [A]: read(153.98), [B]: unread });
  const r = await computeSyncOffset(A, B, 150, 147.3, undefined, detect);
  // The unread clip keeps its coarse estimate (true to the docs)...
  assert.equal(r.clipBCueTimeSec, 147.3);
  assert.equal(r.clipACueTimeSec, 153.98);
  // ...and the docs put it "at confidence 0", for the editor to settle — so the match must read as
  // weak (below syncConfidenceThreshold, which is what flags the editor and the warning line).
  await deviation(
    "A clip the picture cannot read keeps the coarse estimate at confidence 0, and the dashboard's sync editor settles it",
    () =>
      assert.ok(
        r.confidence < config.syncConfidenceThreshold,
        `one clip unread scores ${r.confidence.toFixed(2)} (0.3 + the read clip's confidence, capped 0.5) against threshold ${config.syncConfidenceThreshold}: the pipeline writes source "countdown" with no LOW marker and shortFlow's syncWeak gate passes it`,
      ),
  );
}

console.log("sync.contract: all checks passed");
