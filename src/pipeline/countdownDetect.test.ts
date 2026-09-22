import assert from "node:assert/strict";
import { findCountdownOnset, findMatchStartIndex, frameMotion, whiteCounts } from "./countdownDetect.js";

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

/* --- The digit at the centre of the screen (private rooms let the player look around) ------ */

// White pixels per digit, measured on S11 Pinne–7rowl game 1 in a 96x72 crop of the centre.
const DIGITS = [1532, 715, 809, 599, 726, 800, 750, 662, 766, 607];
const digitSeries = (spec: Array<[seconds: number, count: number]>): number[] => series(spec);

{
  // The shape a real countdown has: a "ready" glyph, the "10" at 14.0s, one digit per second,
  // gone at 24.0s — 0:00 is the end, and the onset is the "10".
  const counts = digitSeries([[13, 0], [1, 407], ...DIGITS.map((n): [number, number] => [1, n]), [6, 3]]);
  const found = findCountdownOnset(counts, 14 * FPS, FPS);
  assert.equal(found.index, 14 * FPS, `expected the "10" at 14s, got ${found.index! / FPS}s`);
  assert.equal(found.endIndex, 24 * FPS, `expected the end at 24s, got ${found.endIndex! / FPS}s`);
  assert.equal(found.seconds, 10);
  assert.ok(found.confidence > 0.7, `a textbook countdown should be confident, got ${found.confidence}`);
}

{
  // A menu on "2" hides the last digits (7rowl): the onset still carries the answer, the end
  // is reported unseen, and the score says so.
  const counts = digitSeries([
    [13, 0],
    [1, 407],
    ...DIGITS.slice(0, 8).map((n): [number, number] => [1, n]),
    [2, 23],
    [6, 0],
  ]);
  const found = findCountdownOnset(counts, 14 * FPS, FPS);
  assert.equal(found.index, 14 * FPS);
  assert.equal(found.endIndex, null);
  assert.equal(found.seconds, 8);
  assert.match(found.detail, /end not seen/);
}

{
  // The "10" blinking off for half its second (Pinne, game 2) is still the "10".
  const counts = digitSeries([
    [13, 0],
    [1, 407],
    [0.4, 1532],
    [0.6, 69],
    ...DIGITS.slice(1).map((n): [number, number] => [1, n]),
    [6, 0],
  ]);
  const found = findCountdownOnset(counts, 14 * FPS, FPS);
  assert.equal(found.index, 14 * FPS);
  assert.equal(found.endIndex, 24 * FPS);
}

{
  // A flash after 0:00 (a client's "go") does not move the end.
  const counts = digitSeries([
    [13, 0],
    [1, 407],
    ...DIGITS.map((n): [number, number] => [1, n]),
    [0.5, 1],
    [0.3, 320],
    [6, 0],
  ]);
  assert.equal(findCountdownOnset(counts, 14 * FPS, FPS).endIndex, 24 * FPS);
}

{
  // A pause menu opened on 0:00 (doogile, 13223455, measured): the "1" drops to 4 in one frame,
  // then the menu's button text holds 70–191 white pixels for half a second. The end is the drop.
  const counts = digitSeries([
    [13, 0],
    [1, 407],
    ...DIGITS.map((n): [number, number] => [1, n]),
    [0.1, 4],
    [0.4, 120],
    [0.2, 92],
    [6, 0],
  ]);
  assert.equal(findCountdownOnset(counts, 14 * FPS, FPS).endIndex, 24 * FPS);
}

{
  // No "10" to anchor on (v_strid, 13141080: the countdown was drawn small through the "9"),
  // and a one-frame flash half a second after the "1" vanishes. The end is the "1"'s drop, not
  // the flash's — a second that is mostly empty is not a digit plateau.
  const counts = digitSeries([
    [6, 30],
    ...DIGITS.slice(2).map((n): [number, number] => [1, n]),
    [0.5, 0],
    [0.1, 234],
    [6, 0],
  ]);
  const found = findCountdownOnset(counts, 4 * FPS, FPS);
  assert.equal(found.endIndex, 14 * FPS, `expected the end at 14s, got ${found.endIndex! / FPS}s`);
}

{
  // A static bright patch in the middle of the frame — snow, a white overlay — has no steps and
  // is not a countdown; nor is a digit that shows for three seconds.
  assert.equal(
    findCountdownOnset(
      digitSeries([
        [10, 0],
        [12, 900],
        [8, 0],
      ]),
      10 * FPS,
      FPS,
    ).index,
    null,
  );
  assert.equal(
    findCountdownOnset(
      digitSeries([
        [10, 0],
        [1, 1532],
        [1, 715],
        [1, 809],
        [17, 0],
      ]),
      10 * FPS,
      FPS,
    ).index,
    null,
  );
}

{
  // Two countdowns in the window (a room reset): the one nearer the estimate wins.
  const one = [[1, 407], ...DIGITS.map((n): [number, number] => [1, n]), [4, 0]] as Array<[number, number]>;
  const counts = digitSeries([[5, 0], ...one, ...one, [5, 0]]);
  assert.equal(findCountdownOnset(counts, 22 * FPS, FPS).index, 21 * FPS);
  assert.equal(findCountdownOnset(counts, 8 * FPS, FPS).index, 6 * FPS);
}

{
  // A late world load (BeefSalad, 13549300, measured): the loading screen's "100%" holds 416
  // white pixels through the "10" and the "9", the world comes in on "8", the "1" vanishes at
  // 148 s. No rise into a fattest digit exists; the drop at the end is the reading.
  const counts = digitSeries([
    [6, 0],
    [4, 416],
    ...[590, 724, 831, 831, 719, 770, 766, 607].map((n): [number, number] => [1, n]),
    [6, 15],
  ]);
  const found = findCountdownOnset(counts, 8 * FPS, FPS);
  assert.equal(found.endIndex, 18 * FPS, `expected the end at 18s, got ${found.endIndex}`);
  assert.equal(found.index, 8 * FPS);
  // The loading screen's two seconds read as digits too; the answer does not depend on them.
  assert.ok(found.seconds >= 8);
  assert.ok(found.confidence > 0.5, `eight stepping digits are a countdown, got ${found.confidence}`);
}

{
  // A full countdown 53 s from the estimate (Aquacorde, 13559245: the VOD's clock ran ahead of
  // the API's) is the countdown, not a candidate the distance term scores to zero.
  const counts = digitSeries([[10, 0], [1, 407], ...DIGITS.map((n): [number, number] => [1, n]), [60, 0]]);
  const found = findCountdownOnset(counts, 64 * FPS, FPS);
  assert.equal(found.index, 11 * FPS);
  assert.ok(
    found.confidence > 0.6,
    `a complete countdown far from the estimate stays trusted, got ${found.confidence}`,
  );
  // ...while four digits that far out do not clear the trust line on their own.
  const partial = digitSeries([
    [10, 0],
    [1, 407],
    ...DIGITS.slice(6).map((n): [number, number] => [1, n]),
    [60, 0],
  ]);
  assert.ok(findCountdownOnset(partial, 64 * FPS, FPS).confidence < 0.3);
}

{
  // A static screen through the "7" (Feinberg, 13395245, measured: 388 white pixels of a
  // waiting screen), then six digits and the drop. The onset pass reads the "6" as a "10" with
  // no end in sight; the end-read candidate has the "1" vanishing, and that outranks distance.
  const counts = digitSeries([
    [6, 388],
    ...[728, 800, 752, 664, 768, 608].map((n): [number, number] => [1, n]),
    [6, 10],
  ]);
  const found = findCountdownOnset(counts, 3 * FPS, FPS);
  assert.equal(found.endIndex, 12 * FPS);
  assert.equal(found.index, 2 * FPS);
}

{
  // The world going dark is not a countdown ending: a snowfield (the whole crop white) into a
  // cave has a drop and varying seconds, and more white than any digit.
  const counts = digitSeries([
    [5, 0],
    ...[6200, 5900, 6400, 6100, 5800, 6300].map((n): [number, number] => [1, n]),
    [6, 0],
  ]);
  assert.equal(findCountdownOnset(counts, 6 * FPS, FPS).index, null);
}

// whiteCounts counts what is at or over the threshold.
assert.deepEqual(whiteCounts([new Uint8Array([0, 235, 255, 234]), new Uint8Array([255])]), [2, 1]);

console.log("countdownDetect: digit checks passed");
