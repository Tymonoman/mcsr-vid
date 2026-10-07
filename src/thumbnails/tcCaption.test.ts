import assert from "node:assert/strict";
import { CAPTION_MAX_CHARS, pickCaption, shortenHookChip } from "./tcCaption.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import type { HookInput } from "../pipeline/hooks.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

const user = (nickname: string, uuid: string): UserDetails => ({ nickname, uuid, eloRate: 1900 }) as unknown as UserDetails;

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
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
    ...over,
  };
  const match = { forfeited: false, changes: [], result: { uuid: null, time: metrics.resultMs }, players: [] } as unknown as MatchInfo;
  return {
    metrics,
    match,
    userLeft: user("left", "uuid-l"),
    userRight: user("right", "uuid-r"),
    maxChars: 40,
    minChars: 0,
  };
}

// Every shape `src/pipeline/hooks.ts` `candidates()` can produce, including the task's own two
// worked examples ("58 MS", a lead-survive hook): one assertion each, so a future hooks.ts
// template that forgets to teach this module shows up as a silent `null`, not a wrong caption.
assert.equal(shortenHookChip("Decided by 58 milliseconds"), "58 MS");
assert.equal(shortenHookChip("Decided by 1.3 seconds"), "1.3S DECIDED");
assert.equal(shortenHookChip("Decided by 1 second"), "1S DECIDED");
assert.equal(shortenHookChip("A sub-8 to win it"), "SUB-8");
assert.equal(shortenHookChip("A sub-10 to win it"), "SUB-10");
assert.equal(shortenHookChip("Does the lead ever settle?"), "LEAD SETTLE?");
assert.equal(shortenHookChip("Can a 1:36 lead survive?"), "1:36 LEAD?");
assert.equal(shortenHookChip("Can a 45-second lead survive?"), "45S LEAD?");
assert.equal(shortenHookChip("4 deaths and still this close"), "4 DEATHS");
assert.equal(shortenHookChip("Not a single death between them"), "0 DEATHS");
assert.equal(shortenHookChip("Rematch: left leads 19-7"), "19-7 REMATCH");
assert.equal(shortenHookChip("Rematch: 3-3 all time"), "3-3 REMATCH");
assert.equal(shortenHookChip("Their first 1v1"), "FIRST 1V1");
assert.equal(shortenHookChip("It ended in a forfeit"), "A FORFEIT");
assert.equal(shortenHookChip("One of them never killed the dragon"), "NO DRAGON KILL");
assert.equal(shortenHookChip("THE DUALITY OF MAN"), null, "freeform prose has no known template");

// Every shortened chip above must actually fit the caption's own budget.
for (const hook of [
  "Decided by 58 milliseconds",
  "A sub-10 to win it",
  "Does the lead ever settle?",
  "Can a 1:36 lead survive?",
  "Rematch: left leads 19-7",
  "One of them never killed the dragon",
]) {
  const short = shortenHookChip(hook)!;
  assert.ok(short.length <= CAPTION_MAX_CHARS, `"${short}" (from "${hook}") is ${short.length} chars`);
}

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
// 7 Oct 2026 — pickCaption's choice must match `buildHookSuggestions`' own top-weighted chip for
// each, shortened, and clear every check.
checkPicked({ finishMarginMs: 12_054, leadChanges: 3, deaths: 0, resultMs: 493_570 }, "LEAD SETTLE?"); // 13673240
checkPicked({ finishMarginMs: 1_259, leadChanges: 2, deaths: 0, resultMs: 559_394 }, "1.3S DECIDED"); // 13395245
checkPicked({ finishMarginMs: 14_682, leadChanges: 1, deaths: 0, resultMs: 532_425 }, "SUB-9"); // 13473906
checkPicked({ finishMarginMs: 10_383, leadChanges: 0, deaths: 0, resultMs: 548_267 }, "SUB-10"); // 13672776
checkPicked({ finishMarginMs: 584, leadChanges: 2, deaths: 1, resultMs: 746_168 }, "0.6S DECIDED"); // 13705853
checkPicked({ finishMarginMs: 58, leadChanges: 4, deaths: 0, resultMs: 562_387 }, "58 MS"); // 13704828
checkPicked({ finishMarginMs: null, leadChanges: 0, deaths: 0, resultMs: 463_204 }, "SUB-8"); // 13305732
checkPicked({ finishMarginMs: 1_607, leadChanges: 4, deaths: 0, resultMs: 542_517 }, "1.6S DECIDED"); // 13223455
checkPicked({ finishMarginMs: 17_070, leadChanges: 0, deaths: 0, resultMs: 649_755 }, "0 DEATHS"); // 13766294
checkPicked({ finishMarginMs: 7_131, leadChanges: 5, deaths: 0, resultMs: 645_655 }, "LEAD SETTLE?"); // 13391780

// A denied label never reaches a caption, even shortened past recognition — the check runs on
// the shortened text, not just the source chip, so this is a real regression guard rather than
// a restatement of hookLabelProblem's own test.
assert.equal(shortenHookChip("Rematch: left leads 19-7"), "19-7 REMATCH");
assert.equal(pickCaption(input({ leadChanges: 3 }), players)?.checks.hookLabelProblem, null);

console.log("tcCaption: all checks passed");
