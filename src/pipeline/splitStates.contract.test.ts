// Contract tests for the overlay's states ("overlay-states"), written from the docs as an outside
// engineer would: CLAUDE.md "What the render produces", README.md "Each match produces", and the
// long form in handbook/claude-md-reference.md "What the render produces". Real matches from
// src/fixtures, props built the way overlayRender.ts builds them, no network, no Chromium.
//
// THE PROMISES (numbered once here; the other *.contract.test.ts files cite these numbers):
//
//  P1  The meta+splits region is "one still per distinct state": the stills tile the whole render
//      with no gap or overlap, nothing in the region changes inside a still, and two neighbouring
//      stills never look the same.                                      (splitStates.ts)
//  P2  "Last state is the subscribe card" (postRollCta, ctaFrameOf), for a finished run.
//  P3  `ctaReason` is one row of at most 24 plain-ASCII characters above SUBSCRIBE; empty is the
//      bare card.                                     (overlayProps.contract.test.ts)
//  P4  The COMING UP card shows from `teaserAtSec` (default 10) after match start for `teaserSec`
//      (5); empty (null) is none.                     (here + overlayProps.contract.test.ts)
//  P5  The teaser's moment comes from `match.timelines` only — ready at render time, no model
//      call, no other match field.                    (teaser.contract.test.ts)
//  P6  An unplanned death, else the biggest-deficit lead change, else a split under 2 s.
//                                                     (teaser.contract.test.ts)
//  P7  Never in the first minute, never in the last minute before the game is decided — whatever
//      kind of moment it is.                          (teaser.contract.test.ts)
//  P8  The teaser names nobody: blind to the seats and to the result. (teaser.contract.test.ts)
//  P9  It reads `death` only, so it never promises a hunger reset, nor sees a bed-spawn death in
//      the End.                                       (teaser.contract.test.ts)
//  P10 "Explain the moves" is off by default (`explainMovesSec` null) — on changes what the
//      nightly renders.                               (here + overlayProps.contract.test.ts)
//  P11 One card the first time EITHER player reaches each of the six MILESTONES splits, showing
//      the split and why; names nobody.               (explainMoves.contract.test.ts)
//  P12 A card that would overlap the SUBSCRIBE line, the teaser or the card before waits (and
//      keeps its whole length); one that would then reach the finish is dropped.   (here)
//  P13 `introSec` is 2–7 (default 7); the intro card lies over the frozen countdown and never
//      moves the timeline anchor.                     (exportFast.contract.test.ts)
//  P14 export:fast cuts `7 - introSec` off the countdown head (`headTrimSec`); match start in the
//      MP4 lands at introSec + 3 s (7 → 0:10, 3 → 0:06); the Kdenlive project stays at 0:10.
//                                                     (exportFast.contract.test.ts)
//  P15 The countdown teaser is off by default; export:fast shows it from the card's end to match
//      start when on and present; absent, the graph is today's. (exportFast.contract.test.ts)
//  P16 `overlay-splits.json`, written last, means "the render finished": nothing is trusted
//      without it, nor a manifest naming a still that is not on disk.
//                                                     (overlayRender.contract.test.ts)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { resolveSplitSide } from "../../remotion/resolveSplitSide.js";
import { chooseMoves } from "./explainMoves.js";
import { computeSplits, explainMovesProp, teaserProp } from "./overlayProps.js";
import {
  CTA_DELAY_SEC,
  ctaFrameOf,
  explainFramesOf,
  midRollFramesOf,
  splitSegments,
  teaserFramesOf,
} from "./splitStates.js";

// Hermetic: nothing in this feature may reach the network.
globalThis.fetch = (async () => {
  throw new Error("network call from a pure overlay-state function");
}) as typeof fetch;

const fixtures = readdirSync(new URL("../fixtures/", import.meta.url))
  .filter((f) => /^match-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8")) as MatchInfo);
assert.ok(fixtures.length >= 10, "the real matches are there to test on");

// The props exactly as overlayRender.ts assembles them: lead-in, run, post-roll at overlayFps.
const FPS = config.overlayFps;
const propsFor = (m: MatchInfo) => {
  const runSec = m.result.time > 0 ? m.result.time / 1000 : config.defaultRunSec;
  return {
    splits: computeSplits(m, m.players[0]!.uuid, m.players[1]!.uuid),
    timerStartFrame: Math.round(config.overlayLeadInSec * FPS),
    runResultMs: m.result.time > 0 ? m.result.time : null,
    durationInFrames: Math.round((config.overlayLeadInSec + runSec + config.postRollSec) * FPS),
    fps: FPS,
    postRollCta: config.postRollCta,
    ...(config.midRollCtaAtSec !== null
      ? { midRollCta: { atSec: config.midRollCtaAtSec, forSec: config.midRollCtaSec } }
      : {}),
    ...teaserProp(m),
    ...explainMovesProp(m),
  };
};
type Props = ReturnType<typeof propsFor>;

const inWindow = (w: [number, number] | null, f: number) => w !== null && f >= w[0] && f < w[1];
const runEndOf = (p: Props) =>
  p.runResultMs !== null ? p.timerStartFrame + (p.runResultMs / 1000) * p.fps : p.durationInFrames;

/**
 * What the region shows on a frame, derived from the docs rather than from splitStates' private
 * fingerprint: each split side pending / its time / DNF once the run is over, and the meta column's
 * one card (the post-roll SUBSCRIBE, the mid-race SUBSCRIBE, COMING UP, a move, else achievements),
 * in Overlay.tsx's order.
 */
const appearanceOf = (p: Props) => {
  const runEnd = runEndOf(p);
  const cta = ctaFrameOf(p);
  const mid = midRollFramesOf(p);
  const teaser = teaserFramesOf(p);
  const cards = explainFramesOf(p);
  return (f: number): string => {
    const rows = p.splits
      .map((r) =>
        [r.leftMs, r.rightMs]
          .map((ms) => {
            const s = resolveSplitSide(ms, p.timerStartFrame, p.fps, runEnd, f);
            return s.kind === "time" ? String(s.ms) : s.kind;
          })
          .join("|"),
      )
      .join(",");
    const meta =
      cta !== null && f >= cta
        ? "SUBSCRIBE(post-roll)"
        : inWindow(mid, f)
          ? "SUBSCRIBE(mid-race)"
          : inWindow(teaser, f)
            ? "COMING UP"
            : (cards.find((c) => inWindow(c.frames, f))?.move.head ?? "achievements");
    return `${rows};${meta}`;
  };
};

/** P1 + P2 on one set of props: every frame of the render checked, not just the edges. */
function checkStills(p: Props, label: string) {
  const segs = splitSegments(p);
  const look = appearanceOf(p);
  // P1: the stills tile [0, duration) — export:fast concatenates them back to back, so a gap or
  // an overlap would slide every later state off its frame.
  assert.equal(segs[0]!.startFrame, 0, `${label}: the first still starts the render`);
  assert.equal(segs.at(-1)!.endFrame, p.durationInFrames, `${label}: the last still ends it`);
  for (let i = 0; i < segs.length; i++) {
    const { startFrame: a, endFrame: b } = segs[i]!;
    assert.ok(b > a, `${label}: still ${i} has frames`);
    if (i > 0) assert.equal(a, segs[i - 1]!.endFrame, `${label}: still ${i} follows the one before`);
    // P1: a still is held for its whole span, so the region must not change anywhere inside it —
    // a reveal, a card edge or the DNF flip mid-still would be on screen at the wrong time.
    const first = look(a);
    for (let f = a + 1; f < b; f++)
      if (look(f) !== first) assert.fail(`${label}: frame ${f} differs from its still (${a}-${b})`);
    // P1: "one still per distinct state" — a still identical to the one before it is not a state.
    if (i > 0) assert.notEqual(first, look(segs[i - 1]!.startFrame), `${label}: still ${i} repeats ${i - 1}`);
  }
  return { segs, look };
}

// --- P1, P2, P4, P10 under DEFAULTS (MCSR_CONFIG points at a missing file) ------------------------
for (const m of fixtures) {
  const p = propsFor(m);
  const label = `${m.id} defaults`;
  const { segs, look } = checkStills(p, label);

  // P2: the last state is the subscribe card, and it begins CTA_DELAY_SEC after the finish — the
  // post-roll is where 35–69% of viewers are still watching with nothing else changing.
  const cta = ctaFrameOf(p)!;
  assert.equal(cta, Math.ceil(runEndOf(p) + CTA_DELAY_SEC * FPS), `${label}: card 3 s after the finish`);
  assert.equal(segs.at(-1)!.startFrame, cta, `${label}: the last still is the card`);
  assert.match(look(segs.at(-1)!.startFrame), /SUBSCRIBE\(post-roll\)$/, `${label}: and it shows SUBSCRIBE`);
  assert.ok(
    segs.slice(0, -1).every((s) => !look(s.startFrame).endsWith("(post-roll)")),
    `${label}: the post-roll card is only ever the last state`,
  );

  // P4: COMING UP from 10 s after match start for 5 s — when the match has a moment at all.
  const tf = teaserFramesOf(p);
  if (p.teaser) {
    assert.deepEqual(
      tf,
      [p.timerStartFrame + 10 * FPS, p.timerStartFrame + 15 * FPS],
      `${label}: the teaser at 10 s for 5 s`,
    );
    assert.ok(segs.some((s) => s.startFrame === tf![0] && look(s.startFrame).endsWith(";COMING UP")));
  } else assert.equal(tf, null, `${label}: no moment, no card`);

  // P10: explain-the-moves is off by default, so the nightly's stills carry no move card.
  assert.deepEqual(explainFramesOf(p), [], `${label}: no move cards by default`);
  const heads = new Set(chooseMoves(m).map((c) => c.head));
  assert.ok(
    segs.every((s) => !heads.has(look(s.startFrame).split(";")[1]!)),
    `${label}: no still shows a move`,
  );
}
console.log("OK: P1/P2/P4/P10 — stills tile every real match, the last is SUBSCRIBE, teaser at 10 s");

// --- P10, P12 with explain-the-moves switched on --------------------------------------------------
const savedExplain = config.explainMovesSec;
try {
  for (const forSec of [6, 15]) {
    // 15 is the Settings tab's maximum: the most crowded the cards can get.
    config.explainMovesSec = forSec;
    for (const m of fixtures) {
      const p = propsFor(m);
      const label = `${m.id} explain ${forSec}s`;
      checkStills(p, label);
      const off = splitSegments({ ...p, explainMoves: undefined });
      // P10: "on changes what the nightly renders" — more stills than with the setting off.
      assert.ok(splitSegments(p).length > off.length, `${label}: on renders differently`);
      checkCards(p, m, label);
    }
  }

  // P12: a card that would reach the finish is dropped. Move the End entry to five seconds before
  // the finish on a real match: a 6 s THE END card cannot fit and must not spill onto the post-roll.
  config.explainMovesSec = 6;
  for (const m of fixtures) {
    const lateEnd = {
      ...m,
      timelines: m.timelines.map((e) =>
        e.type === "story.enter_the_end" ? { ...e, time: Math.max(e.time, m.result.time - 5_000) } : e,
      ),
    };
    const p = propsFor(lateEnd);
    const shown = explainFramesOf(p).map((c) => c.move.head);
    assert.ok(!shown.includes("THE END"), `${m.id}: a card reaching the finish is dropped`);
    checkCards(p, lateEnd, `${m.id} late End`);
    checkStills(p, `${m.id} late End`);
  }
} finally {
  config.explainMovesSec = savedExplain;
}
console.log("OK: P10/P12 — move cards wait for SUBSCRIBE, the teaser and each other, none at the finish");

/** P12 on one set of props, checked against an independent search for a free slot. */
function checkCards(p: Props, m: MatchInfo, label: string) {
  const cards = explainFramesOf(p);
  const len = Math.ceil(p.explainMoves!.forSec * p.fps);
  const runEnd = runEndOf(p);
  const blockers = [midRollFramesOf(p), teaserFramesOf(p)].filter((w) => w !== null);
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
  const moves = [...chooseMoves(m)].sort((a, b) => a.atMs - b.atMs);
  cards.forEach(({ frames, move }, i) => {
    const own = Math.ceil(p.timerStartFrame + (move.atMs / 1000) * p.fps);
    // Waiting only ever delays a card; it is never shown before the split is reached.
    assert.ok(frames[0] >= own, `${label}: ${move.head} shown before its split`);
    // "waits" — not cut short: the card keeps its whole time on screen.
    assert.equal(frames[1] - frames[0], len, `${label}: ${move.head} keeps its length`);
    for (const w of blockers) assert.ok(!overlaps(frames, w), `${label}: ${move.head} over SUBSCRIBE/teaser`);
    if (i > 0)
      assert.ok(!overlaps(frames, cards[i - 1]!.frames), `${label}: ${move.head} over the card before`);
    // Never reaching the finish, so never on the post-roll subscribe card either.
    assert.ok(frames[1] <= runEnd, `${label}: ${move.head} reaches the finish`);
  });
  // A dropped card is one that would have reached the finish: so the shown cards are the earliest
  // moves (nothing in the middle vanishes), and the first one left out had no room before the end.
  assert.deepEqual(
    cards.map((c) => c.move.head),
    moves.slice(0, cards.length).map((c) => c.head),
    `${label}: only the tail is dropped`,
  );
  const dropped = moves[cards.length];
  if (dropped) {
    const taken = [...blockers, ...cards.map((c) => c.frames)];
    let s = Math.ceil(p.timerStartFrame + (dropped.atMs / 1000) * p.fps);
    while (taken.some((w) => overlaps([s, s + len], w))) s++;
    assert.ok(s + len > runEnd, `${label}: ${dropped.head} dropped though it fit at ${s}`);
  }
}

// --- P1 on a forfeit: no finish time, so the region still tiles and nothing is proven DNF early ----
{
  const m = fixtures[0]!;
  const forfeit = { ...m, result: { ...m.result, time: 0 } };
  const p = propsFor(forfeit);
  checkStills(p, `${m.id} forfeit`);
  // With no finish there is no post-roll to put a card on (overlayProps maps result.time 0 to null).
  assert.equal(ctaFrameOf(p), null, "a forfeit gets no subscribe card stamped on an unknown finish");
}

console.log("splitStates.contract: all checks passed");
