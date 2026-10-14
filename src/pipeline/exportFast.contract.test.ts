// Contract tests for how export:fast lays the intro card, the head trim and the countdown teaser
// (command building only, src/pipeline/exportFast.ts), from CLAUDE.md "What the render produces"
// and handbook/claude-md-reference.md. Promises of the list at the top of
// splitStates.contract.test.ts:
//
//  P13 The intro card (`introSec`, 2–7) lies over the frozen countdown and never moves the
//      timeline anchor.
//  P14 export:fast cuts `7 - introSec` off the countdown head (`headTrimSec`); match start in the
//      MP4 lands at introSec + 3 s (7 → 0:10, 3 → 0:06); the Kdenlive project stays at 0:10.
//  P15 The countdown teaser shows from the card's end to match start when on and present; absent,
//      the graph is today's.
//
// exportFast.test.ts pins one trim (4 s) and one teaser window; this sweeps every introSec the
// Settings tab allows and checks the promised seconds of the MP4, not the filter text alone.
// Nothing runs ffmpeg.
import assert from "node:assert/strict";
import { buildFastExportCommand, headTrimSec } from "./exportFast.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";

const FPS = 60;
const base = {
  leftClip: { path: "/m/left.mp4", durationSec: 900, matchOffsetIntoClipSec: 150, clipName: "L" },
  rightClip: { path: "/m/right.mp4", durationSec: 900, matchOffsetIntoClipSec: 147.25, clipName: "R" },
  topPath: "/m/overlay-top.png",
  splits: [
    { path: "/m/overlay-splits-0.png", startSec: 0, durationSec: 300 },
    { path: "/m/overlay-splits-1.png", startSec: 300, durationSec: 340 },
  ],
  timerPath: "/m/overlay-timer.mp4",
  introPath: "/m/overlay-intro.webm",
  introOffsetSec: 0,
  fps: FPS,
  totalDurationSec: 640,
  outPath: "/m/final-1.mp4",
};
const filterOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;
const seekOf = (args: string[], file: string) => args[args.indexOf(file) - 2];
const inputs = (args: string[]) => args.filter((a) => a === "-i").length;
const untrimmed = buildFastExportCommand(base).args;

// P14: "Kdenlive stays at 0:10" — the timeline's anchor is the countdown's tenth second.
assert.equal(ANCHOR_SEC, 10);

// The Settings tab's whole range, plus two card lengths as a probe of the rendered file reads them.
for (const introSec of [2, 3, 4, 5, 6, 7, 3.017, 7.017]) {
  const label = `introSec ${introSec}`;
  const trim = headTrimSec(introSec);
  const card = Math.round(introSec * 10) / 10; // the card length the trim is cut for, to tenths

  // P14: 7 - introSec off the head, so match start in the MP4 is introSec + 3 s.
  assert.equal(trim, Math.max(0, Math.round((7 - card) * 10) / 10), `${label}: cuts 7 - introSec`);
  const matchStartInMp4 = ANCHOR_SEC - trim;
  assert.equal(
    Math.round(matchStartInMp4 * 1000),
    Math.round((Math.min(card, 7) + 3) * 1000),
    `${label}: match start`,
  );

  // As exportFastCli builds it: the trim when there is one, and the countdown teaser over
  // [card end, match start) in timeline seconds.
  const cardEndOnTimeline = trim + introSec;
  const withTeaser = buildFastExportCommand({
    ...base,
    ...(trim > 0 ? { headTrimSec: trim } : {}),
    countdownTeaserPath: "/m/overlay-countdown-teaser.png",
    countdownTeaserStartSec: cardEndOnTimeline,
    countdownTeaserEndSec: ANCHOR_SEC,
  }).args;
  const f = filterOf(withTeaser);
  const trimFrames = Math.round(trim * FPS);

  // P13: the card never moves the anchor — both clips are seeked exactly as with a 7 s card.
  for (const clip of ["/m/left.mp4", "/m/right.mp4"])
    assert.equal(seekOf(withTeaser, clip), seekOf(untrimmed, clip), `${label}: ${clip} moved`);

  // P13: the card opens the video — it starts on the MP4's own 0, over the stage after the trim.
  assert.ok(f.includes("setpts=N/60/TB+0/TB[INTRO]"), `${label}: the card at the MP4's 0`);
  const stageUnderCard = trimFrames > 0 ? "[STAGET]" : "[STAGEC]";
  assert.ok(f.includes(`${stageUnderCard}[INTRO]overlay=`), `${label}: the card over ${stageUnderCard}`);

  // P14: picture and sound both lose the same head, and the MP4 is that much shorter.
  if (trimFrames > 0) {
    assert.ok(
      f.includes(`trim=start_frame=${trimFrames},setpts=PTS-STARTPTS[STAGET]`),
      `${label}: picture trim`,
    );
    assert.ok(f.includes(`atrim=start=${(trimFrames / FPS).toFixed(6)},`), `${label}: sound trim`);
  } else {
    assert.ok(!f.includes("trim=start_frame") && !f.includes("atrim="), `${label}: a 7 s card cuts nothing`);
  }
  assert.equal(
    withTeaser[withTeaser.indexOf("-t") + 1],
    (base.totalDurationSec - trimFrames / FPS).toFixed(3),
  );

  // P15: in the MP4, the countdown teaser is up from the card's end to match start — no earlier
  // (over the card), no later (over the race).
  const ct = /loop=loop=(\d+):size=1:start=0,settb=1\/60,setpts=N\/60\/TB\+(\d+)\[CT\]/.exec(f);
  assert.ok(ct, `${label}: no countdown teaser chain`);
  const [fromTimeline, frames] = [Number(ct[2]), Number(ct[1]) + 1];
  assert.ok(f.includes("[STAGE][CT]overlay="), `${label}: laid on the timeline, before the trim`);
  assert.equal(fromTimeline - trimFrames, Math.round(introSec * FPS), `${label}: starts as the card ends`);
  assert.equal(
    fromTimeline + frames - trimFrames,
    Math.round(matchStartInMp4 * FPS),
    `${label}: ends on match start`,
  );

  // P15: absent (setting off, or no file), the graph is exactly the one without it: one input
  // fewer, no teaser chain, and the intro the only alpha composite.
  const without = buildFastExportCommand({ ...base, ...(trim > 0 ? { headTrimSec: trim } : {}) }).args;
  const wf = filterOf(without);
  assert.equal(inputs(without), inputs(withTeaser) - 1, `${label}: no teaser input`);
  assert.ok(!wf.includes("[CT]") && !without.includes("/m/overlay-countdown-teaser.png"), `${label}: no teaser chain`);
  assert.equal((wf.match(/overlay=/g) ?? []).length, 1, `${label}: only the intro is composited`);
}

// P14 by the doc's own examples: 7 → 0:10, 3 → 0:06.
assert.equal(ANCHOR_SEC - headTrimSec(7), 10);
assert.equal(ANCHOR_SEC - headTrimSec(3), 6);

console.log("exportFast.contract: all checks passed");
