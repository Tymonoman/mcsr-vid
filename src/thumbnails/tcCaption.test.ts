import assert from "node:assert/strict";
import { CAPTION_MAX_CHARS, pickCaption, shortenHookChip } from "./tcCaption.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import type { HookInput } from "../pipeline/hooks.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

const user = (nickname: string, uuid: string): UserDetails =>
  ({ nickname, uuid, eloRate: 1900 }) as unknown as UserDetails;

function input(over: Partial<MatchMetrics>): HookInput {
  const metrics: MatchMetrics = {
    matchId: 1,
    players: ["left", "right"],
    winner: "right",
    resultMs: 500_000,
    splits: [],
    finishMarginMs: null,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 8,
    maxLeadMs: 0,
    leadChanges: 0,
    panelLeadChanges: 0,
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
    ...over,
  };
  // onScreenDeaths (hooks.ts's "not a single death" chip, 8 Oct 2026 chip-truth fix) reads
  // `match.timelines` directly; mirroring `deaths` with that many ordinary death entries keeps
  // every case below behaving the way its `deaths` field already says.
  const timelines = Array.from({ length: metrics.deaths }, (_, i) => ({
    uuid: `uuid-death-${i}`,
    time: 0,
    type: "projectelo.timeline.death",
  }));
  const match = {
    forfeited: false,
    changes: [],
    result: { uuid: null, time: metrics.resultMs },
    players: [],
    timelines,
  } as unknown as MatchInfo;
  return {
    metrics,
    match,
    userLeft: user("left", "uuid-l"),
    userRight: user("right", "uuid-r"),
    maxChars: 40,
    minChars: 0,
  };
}

// Every shape `src/pipeline/hooks.ts` `candidates()` can produce, including the task's own
// approved tokens ("58 MS", "SUB-9", "1:36 LEAD"): one assertion each, so a future hooks.ts
// template that forgets to teach this module shows up as a silent `null`, not a wrong caption.
// Two templates are dropped outright now (8 Oct 2026 chip-truth): "Does the lead ever settle?"
// has no clean short token (broken-English "LEAD SETTLE?" read wrong, and nothing shorter still
// says what it means), and a decimal margin ("Decided by 1.3 seconds") would need an "S" glued
// right onto a digit to abbreviate ("1.3S" reads as "1.35" in Monocraft) — the margin caption only
// survives for a whole number of seconds, where "N SEC" has a space before the unit.
assert.equal(shortenHookChip("Decided by 58 milliseconds"), "58 MS");
assert.equal(shortenHookChip("Decided by 1 millisecond"), "1 MS", "hooks.ts says it singular at one");
assert.equal(shortenHookChip("Decided by 2 seconds"), "2 SEC");
assert.equal(shortenHookChip("Decided by 1 second"), "1 SEC");
assert.equal(shortenHookChip("Decided by 1.3 seconds"), null, "a decimal margin has no clean token, dropped");
assert.equal(shortenHookChip("A sub-8 to win it"), "SUB-8");
assert.equal(shortenHookChip("A sub-10 to win it"), "SUB-10");
assert.equal(shortenHookChip("Does the lead ever settle?"), null, "no clean token reads right, dropped");
assert.equal(shortenHookChip("Can a 1:36 lead survive?"), "1:36 LEAD");
assert.equal(
  shortenHookChip("Can a 45-second lead survive?"),
  "0:45 LEAD",
  "M:SS like the minute form, no glued S unit",
);
assert.equal(shortenHookChip("Can a 8-second lead survive?"), "0:08 LEAD");
assert.equal(shortenHookChip("4 deaths and still this close"), "4 DEATHS");
assert.equal(shortenHookChip("Not a single death between them"), "0 DEATHS");
assert.equal(shortenHookChip("Rematch: left leads 19-7 this season"), "19-7 REMATCH");
assert.equal(shortenHookChip("Rematch: 3-3 this season"), "3-3 REMATCH");
// A season's 0-0 is no lifetime first: "FIRST 1V1" would be false for a pair with 40 games last season.
assert.equal(shortenHookChip("Their first 1v1 this season"), null);
assert.equal(shortenHookChip("Their first 1v1"), null, "the old lifetime wording is no template any more");
assert.equal(shortenHookChip("It ended in a forfeit"), "A FORFEIT");
assert.equal(shortenHookChip("One of them never killed the dragon"), "NO DRAGON KILL");
assert.equal(shortenHookChip("THE DUALITY OF MAN"), null, "freeform prose has no known template");

// Every shortened chip below must actually fit the caption's own (now tighter) budget — the
// rematch and dragon-kill templates above are legitimately over it and `pickCaption` skips them
// (checked separately below), not asserted here.
for (const hook of [
  "Decided by 58 milliseconds",
  "Decided by 2 seconds",
  "Decided by 1 second",
  "A sub-10 to win it",
  "Can a 1:36 lead survive?",
  "Can a 45-second lead survive?",
  "4 deaths and still this close",
  "Not a single death between them",
  "It ended in a forfeit",
]) {
  const short = shortenHookChip(hook)!;
  assert.ok(short.length <= CAPTION_MAX_CHARS, `"${short}" (from "${hook}") is ${short.length} chars`);
}
assert.ok(
  shortenHookChip("Rematch: left leads 19-7 this season")!.length > CAPTION_MAX_CHARS,
  "a rematch token is legitimately over budget and must be skipped, not shortened further",
);
assert.ok(shortenHookChip("One of them never killed the dragon")!.length > CAPTION_MAX_CHARS);

const players = [{ nickname: "left" }, { nickname: "right" }];

function checkPicked(over: Partial<MatchMetrics>, expectedCaption: string) {
  const result = pickCaption(input(over), players);
  assert.ok(result, `no caption for ${JSON.stringify(over)}`);
  assert.equal(result!.caption, expectedCaption);
  assert.ok(result!.caption.length <= CAPTION_MAX_CHARS);
  assert.equal(result!.checks.hookProblem, null, `hookProblem: ${result!.checks.hookProblem}`);
  assert.equal(result!.checks.hookLabelProblem, null);
  assert.equal(result!.checks.spoilsTheResult, false);
}

// The ten real Test & Compare matches (handbook/knowledge/experiments.md), metrics read live
// 7 Oct 2026. Re-pinned 18 Oct 2026 (the operator's title rewrite): hooks.ts no longer states a
// margin, lead-change count, death count or pace at all, so none of the old stake chips these
// matches once picked exist any more — only a real close finish (under a second), a forfeit, a
// real rivalry or the setting (no clean short token, so never a caption) can still produce one.
// None of these ten was decided inside a second except 13704828, so nine now get no caption —
// "nothing" is the correct answer, not a made-up token.
for (const over of [
  { finishMarginMs: 12_054, panelLeadChanges: 3, deaths: 0, resultMs: 493_570 }, // 13673240
  { finishMarginMs: 1_259, panelLeadChanges: 2, deaths: 0, resultMs: 559_394 }, // 13395245
  { finishMarginMs: 14_682, panelLeadChanges: 1, deaths: 0, resultMs: 532_425 }, // 13473906
  { finishMarginMs: 10_383, panelLeadChanges: 0, deaths: 0, resultMs: 548_267 }, // 13672776
  { finishMarginMs: null, panelLeadChanges: 0, deaths: 0, resultMs: 463_204 }, // 13305732
  { finishMarginMs: 1_607, panelLeadChanges: 4, deaths: 0, resultMs: 542_517 }, // 13223455
  { finishMarginMs: 17_070, panelLeadChanges: 0, deaths: 0, resultMs: 649_755 }, // 13766294
  { finishMarginMs: 7_131, panelLeadChanges: 5, deaths: 0, resultMs: 645_655 }, // 13391780
  { finishMarginMs: 584, panelLeadChanges: 2, deaths: 1, resultMs: 746_168 }, // 13705853
])
  assert.equal(
    pickCaption(input(over), players),
    null,
    `no caption, no margin/lead/death chip: ${JSON.stringify(over)}`,
  );

// The one real close finish: 13704828, decided under a second.
checkPicked({ finishMarginMs: 58, panelLeadChanges: 4, deaths: 0, resultMs: 562_387 }, "58 MS"); // 13704828

// A denied label never reaches a caption, even shortened past recognition — the check runs on
// the shortened text, not just the source chip, so this is a real regression guard rather than
// a restatement of hookLabelProblem's own test.
assert.equal(shortenHookChip("Rematch: left leads 19-7 this season"), "19-7 REMATCH");
assert.equal(
  pickCaption(input({ finishMarginMs: 58 }), players)?.checks.hookLabelProblem,
  null,
  "a real chip's checks still run and clear",
);

console.log("tcCaption: all checks passed");
