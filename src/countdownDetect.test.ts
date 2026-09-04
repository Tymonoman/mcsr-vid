import assert from "node:assert/strict";
import { findMatchStartIndex, frameMotion } from "./countdownDetect.js";

const FPS = 10;

/** A motion series in seconds-of-behaviour, at FPS samples per second. */
function series(spec: Array<[seconds: number, level: number]>): number[] {
  const out: number[] = [];
  for (const [seconds, level] of spec) {
    for (let i = 0; i < Math.round(seconds * FPS); i++) out.push(level);
  }
  return out;
}

{
  // The shape a real match has: busy menu, a 10s freeze through the countdown, then gameplay
  // that never stops. Measured on match 12296170, still frames sat at ~0.3 and gameplay at 30-60.
  const motion = series([
    [8, 40], // menu / world loading
    [10, 0.3], // the countdown: the player cannot move
    [15, 35], // gameplay
  ]);
  const expected = 18 * FPS;
  const found = findMatchStartIndex(motion, expected, FPS);
  assert.equal(found.index, 18 * FPS, `expected the freeze to end at 18s, got ${found.index! / FPS}s`);
  assert.ok(found.confidence > 0.5, `a textbook countdown should be confident, got ${found.confidence}`);
  assert.equal(found.stillRunSec, 10);
}

{
  // Isolated single-frame flickers inside the freeze — the countdown digit changing, a chat
  // message, the "Waiting for players" banner clearing. These must not split the run.
  const motion = series([
    [8, 40],
    [4, 0.3],
    [0.1, 50],
    [6, 0.3],
    [15, 35],
  ]);
  const found = findMatchStartIndex(motion, 18 * FPS, FPS);
  assert.ok(found.index !== null, "a flicker inside the freeze must not hide the countdown");
  // The run after the flicker is 6s, which still clears MIN_STILL_SEC.
  assert.ok(
    Math.abs(found.index! / FPS - 18.1) < 0.2,
    `expected the start near 18.1s, got ${found.index! / FPS}s`,
  );
}

{
  // Tabbed out: nothing on screen ever moves, so there is no freeze-then-motion transition to
  // find. Returning "somewhere" here would anchor the whole published video on nothing.
  const found = findMatchStartIndex(series([[30, 0.2]]), 15 * FPS, FPS);
  assert.equal(found.index, null);
  assert.equal(found.confidence, 0);
}

{
  // Never still: a busy stream where the player never froze. Also no answer.
  const found = findMatchStartIndex(series([[30, 45]]), 15 * FPS, FPS);
  assert.equal(found.index, null);
  assert.equal(found.confidence, 0);
}

{
  // Motion that stops again immediately is a menu flicker, not a match starting.
  const motion = series([
    [8, 40],
    [10, 0.3],
    [0.5, 40],
    [10, 0.3],
    [5, 40],
  ]);
  const found = findMatchStartIndex(motion, 18 * FPS, FPS);
  // The 0.5s blip fails the sustained check, so the freeze that counts is the second one.
  assert.ok(
    found.index === null || Math.abs(found.index / FPS - 28.5) < 0.3,
    `a half-second blip must not be read as the start; got ${found.index === null ? "null" : found.index / FPS}`,
  );
}

{
  // Two qualifying freezes: an earlier idle and the real countdown. The coarse API estimate is
  // the tiebreaker — without it a VOD with a previous match in the pre-roll anchors on the
  // wrong one, which is a confident, plausible, completely wrong answer.
  const motion = series([
    [2, 40],
    [8, 0.3],
    [10, 40],
    [10, 0.3],
    [10, 40],
  ]);
  const near = findMatchStartIndex(motion, 30 * FPS, FPS);
  assert.ok(Math.abs(near.index! / FPS - 30) < 0.3, `expected the later freeze, got ${near.index! / FPS}`);
  const early = findMatchStartIndex(motion, 10 * FPS, FPS);
  assert.ok(
    Math.abs(early.index! / FPS - 10) < 0.3,
    `expected the earlier freeze, got ${early.index! / FPS}`,
  );
}

{
  // frameMotion is a plain mean absolute difference; a still pair is 0 and a full flip is 255.
  const a = new Uint8Array([0, 0, 0, 0]);
  const b = new Uint8Array([255, 255, 255, 255]);
  assert.deepEqual(frameMotion([a, a]), [0]);
  assert.deepEqual(frameMotion([a, b]), [255]);
  assert.deepEqual(frameMotion([a]), []);
}

console.log("countdownDetect: all checks passed");
