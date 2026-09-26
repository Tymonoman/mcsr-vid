import assert from "node:assert/strict";
import { modelFraction, phasePercent, pickPhases, pickProgress, watchFraction } from "./pickProgress.js";

const phases = pickPhases([["edcr", "Feinberg"]], "gemini");
assert.deepEqual(
  phases.map((p) => p.line),
  [
    "making the model's copy of the video",
    "running /watch on edcr's stream · 1 of 2",
    "running /watch on Feinberg's stream · 2 of 2",
    "gemini is watching the match",
  ],
);
// 200 + 115 + 115 + 150 = 580 s.
assert.equal(phasePercent(phases, 0, 0), 0);
assert.equal(phasePercent(phases, 0, 1), 34, "the proxy is 200 of 580 s");
assert.equal(phasePercent(phases, 1, 1), phasePercent(phases, 2, 0), "a phase's end is the next one's start");
assert.equal(phasePercent(phases, 2, 1), 74);
assert.equal(phasePercent(phases, 3, 1), 99, "never 100 before the pick is written");
assert.equal(phasePercent(phases, 0, -3), 0, "fraction clamped below");
assert.equal(phasePercent(phases, 0, 7), 34, "fraction clamped above");
assert.equal(phasePercent(phases, 0, NaN), 0);
assert.equal(phasePercent(phases, 99, 1), 99, "phase clamped");

// A series: the proxy per game, every game's POVs in order.
const series = pickPhases(
  [
    ["a", "b"],
    ["a", "b"],
  ],
  "m",
);
assert.equal(series.length, 6);
assert.equal(series[0]!.weight, 400);
assert.equal(series[4]!.line, "running /watch on b's stream · 4 of 4");

// The model's estimate rises and never arrives.
assert.equal(modelFraction(0), 0);
assert.ok(modelFraction(150_000) > 0.6 && modelFraction(150_000) < 0.65);
assert.ok(modelFraction(3_600_000) < 1);
assert.equal(modelFraction(-5), 0);
assert.ok(phasePercent(phases, 3, modelFraction(3_600_000)) <= 99);

// watch.py: nothing announced yet, the stills against the announced count, then the markers.
const opening = "[watch] working dir: /x\n[watch] using local file…\n";
assert.equal(watchFraction(opening, 40), 0, "stale stills before the announcement count for nothing");
const extracting = `${opening}[watch] extracting ~100 frames at 0.185 fps over 00:12-09:10 (538.0s)…\n`;
assert.equal(watchFraction(extracting, 0), 0);
assert.equal(watchFraction(extracting, 50), 0.465);
assert.equal(watchFraction(extracting, 250), 0.93, "capped at the stills' share");
assert.equal(watchFraction("[watch] extracting ~250 frames at 2 fps", 100), 0.93, "watch.py caps at 100");
const audio = `${extracting}[watch] extracting audio for Whisper (groq)…\n`;
assert.equal(watchFraction(audio, 100), 0.95);
assert.equal(watchFraction(`${audio}[watch] audio: 4200 kB — uploading to groq Whisper…\n`, 100), 0.97);
assert.equal(watchFraction(`${audio}[watch] transcribed 22 segments via groq\n`, 100), 0.99);
assert.equal(watchFraction(`${audio}[watch] whisper fallback failed: 429\n`, 100), 0.99);

// The tracker: monotonic across a retried model ask, the phase's line reported each time.
const seen: Array<[number, string]> = [];
const bar = pickProgress(phases, (p, line) => seen.push([p, line]));
bar.at(0, 0.5);
bar.at(1, 0.2);
bar.at(3, modelFraction(300_000));
const high = bar.percent;
bar.at(3, modelFraction(1_000)); // asked once more: its clock restarts
assert.equal(bar.percent, high, "the bar holds, never back");
bar.at(0, 1); // a late proxy report
assert.equal(bar.percent, high);
assert.ok(
  seen.every(([p], i) => i === 0 || p >= seen[i - 1]![0]),
  "monotonic",
);
assert.equal(seen[1]![1], "running /watch on edcr's stream · 1 of 2");
assert.ok(seen.every(([p]) => p < 100));

console.log("pickProgress: ok");
