// Self-check for raceGap.ts on real matches (src/fixtures): who leads where, the gap at the last
// rung both reached, and the captions a Short of a given window carries — none of them at or after
// the moment the game is decided. Run: npx tsx src/shorts/raceGap.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { CAPTION_MAX_CHARS, decidedAtMs, formatGap, raceCaptions, raceStateAt } from "./raceGap.js";
import type { ShortPick } from "./shortPlan.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const pick = (id: number, startSec: number, endSec: number, pov: ShortPick["pov"] = "both"): ShortPick => ({
  gameMatchId: id,
  startMs: startSec * 1000,
  endMs: endSec * 1000,
  pov,
  hookSuggestion: "",
  why: "",
  kind: "race",
  source: "heuristic",
  createdAt: "",
});
const texts = (m: MatchInfo, p: ShortPick) => raceCaptions(m, p).map((c) => [c.atMs, c.text, c.side]);

// --- 12730175, edcr (left) vs doogile (right): edcr ahead all run, both die 0.4 s apart, then
// into the End 2.1 s apart. The first caption is the stronghold gap (10.1 s), the place dropped
// because the line would run past 32 characters.
const edcr = load(12730175);
assert.deepEqual(texts(edcr, pick(12730175, 560, 600)), [
  [4000, "DOOGILE 10 S BEHIND", "right"],
  [4680, "EDCR DIES", "left"],
  [5066, "DOOGILE DIES", "right"],
  [9945, "EDCR FIRST INTO THE END", "left"],
  [12048, "DOOGILE IN THE END · 2.1 S APART", "right"],
]);
// Both went blind 0.8 s apart: a dead heat as far as the caption goes.
assert.deepEqual(texts(edcr, pick(12730175, 400, 420))[0], [4000, "NECK AND NECK", null]);
assert.deepEqual(texts(edcr, pick(12730175, 0, 30))[0], [4000, "BOTH STILL IN THE OVERWORLD", null]);
// The first dragon dies at 10:12.4: a window running through it gets nothing from then on…
assert.equal(decidedAtMs(edcr), 612_431);
assert.deepEqual(texts(edcr, pick(12730175, 600, 622)), [[4000, "DOOGILE 2.1 S BEHIND", "right"]]);
// …and a window whose hook runs into it gets no caption at all.
assert.deepEqual(raceCaptions(edcr, pick(12730175, 610, 622)), []);
console.log("OK: 12730175 — the gap, the deaths, the End 2.1 s apart, nothing past the decision");

// --- 12929221, Feinberg (left) vs silverrruns (right): silverrruns blind 2:11 earlier, Feinberg
// into the stronghold first all the same, silverrruns first into the End — two lead changes.
const feinberg = load(12929221);
const at516 = raceStateAt(feinberg, 516_000);
assert.deepEqual([at516.milestone?.label, at516.leader, at516.gapMs], ["Stronghold", "left", null]);
assert.deepEqual(texts(feinberg, pick(12929221, 505, 535)), [
  [4000, "FEINBERG 2:11 BEHIND", "left"],
  [9022, "FEINBERG FIRST TO THE STRONGHOLD", "left"],
  [13522, "SILVERRRUNS IN THE STRONGHOLD", "right"],
  [20169, "SILVERRRUNS FIRST INTO THE END", "right"],
]);
// One POV: what that player is doing, then only their own events.
assert.deepEqual(texts(feinberg, pick(12929221, 505, 535, "right")), [
  [4000, "SILVERRRUNS · BLIND TRAVEL", "right"],
  [13522, "SILVERRRUNS IN THE STRONGHOLD", "right"],
  [20169, "SILVERRRUNS FIRST INTO THE END", "right"],
]);
console.log(
  "OK: 12929221 — the lead flips at the stronghold and back at the End; one POV keeps to its player",
);

assert.deepEqual(
  [0.3, 9.96, 14.4, 130.6].map((s) => formatGap(s * 1000)),
  ["0.3 S", "10 S", "14 S", "2:11"],
);

// --- Every window of every fixture, every POV: upper case, within budget, never at or after the
// decision, never a word of the result.
for (const id of [12730175, 12898432, 12902901, 12929221]) {
  const m = load(id);
  const decided = decidedAtMs(m)!;
  for (let s = 0; s < m.result.time / 1000; s += 7) {
    for (const pov of ["both", "left", "right"] as const) {
      const p = pick(id, s, s + 30, pov);
      for (const c of raceCaptions(m, p)) {
        assert.ok(c.text.length <= CAPTION_MAX_CHARS, `${id}@${s}: "${c.text}" is over budget`);
        assert.equal(c.text, c.text.toUpperCase());
        assert.ok(p.startMs + c.atMs < decided, `${id}@${s}: "${c.text}" at or past the decision`);
        assert.ok(c.atMs >= 4000 && c.atMs < 30_000, `${id}@${s}: "${c.text}" outside the window`);
        assert.doesNotMatch(c.text, /\b(WIN|WON|WINNER|BEAT|LOST|DEFEAT|CHAMPION|VICTORY|TAKES IT)\b/);
      }
    }
  }
}
// A forfeit with no dragon: the forfeit is the decision.
assert.equal(decidedAtMs({ ...edcr, timelines: [], result: { uuid: null, time: 145_000 } }), 145_000);
console.log("raceGap: all checks passed");
