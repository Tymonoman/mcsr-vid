import assert from "node:assert/strict";
import { buildHookSuggestions, hookFacts, suggestHooksExternally, type HookInput } from "./hooks.js";
import type { MatchMetrics } from "./matchScore.js";
import type { MatchInfo, UserDetails } from "./types.js";

/** Budget from a real pair of nicknames: buildTitle("edcr","doogile") gives 34-47. */
const MAX = 47;
const MIN = 34;

function input(over: Partial<MatchMetrics> = {}, matchOver: Partial<MatchInfo> = {}): HookInput {
  const metrics: MatchMetrics = {
    matchId: 1,
    players: ["edcr", "doogile"],
    winner: "edcr",
    resultMs: 700_000,
    splits: [],
    finishMarginMs: 30_000,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 8,
    maxLeadMs: 20_000,
    leadChanges: 0,
    maxSwingMs: 0,
    deaths: 1,
    deathsByPlayer: { edcr: 1 },
    ...over,
  };
  const match = {
    forfeited: false,
    changes: [],
    result: { uuid: null, time: metrics.resultMs },
    players: [],
    ...matchOver,
  } as unknown as MatchInfo;
  const user = (nickname: string, uuid: string): UserDetails =>
    ({ nickname, uuid, eloRate: 1900 }) as unknown as UserDetails;
  return {
    metrics,
    match,
    userLeft: user("edcr", "uuid-l"),
    userRight: user("doogile", "uuid-r"),
    maxChars: MAX,
    minChars: MIN,
  };
}

// A photo finish is the whole story and must lead. The number is the real margin, not a
// rounding — a hook that overstates the match is worse than no hook.
const photo = buildHookSuggestions(input({ finishMarginMs: 2_400 }));
assert.equal(photo[0], "Decided by 2.4 seconds");

// A whole second renders without a trailing ".0".
assert.equal(buildHookSuggestions(input({ finishMarginMs: 2_000 }))[0], "Decided by 2 seconds");

// Ranking: a 4-lead-change race outranks the deathless note that also applies to it.
const chaotic = buildHookSuggestions(input({ leadChanges: 4, deaths: 0, finishMarginMs: 30_000 }));
assert.equal(chaotic[0], "The lead changed 4 times");
assert.ok(chaotic.includes("Not a single death between them"));

// A DNF is normal (the loser stops once the winner is done), so it must not outrank real drama.
const dnf = buildHookSuggestions(input({ finishMarginMs: null, leadChanges: 3 }));
assert.equal(dnf[0], "The lead changed 3 times");
assert.ok(dnf.includes("One of them never reached the dragon"));

// Every suggestion has to fit the title budget, or it cannot be used at all.
for (const text of buildHookSuggestions(input({ leadChanges: 5, deaths: 7, maxSwingMs: 90_000 }))) {
  assert.ok(text.length <= MAX, `"${text}" is ${text.length} chars, over the ${MAX} budget`);
}

// A tiny budget yields nothing rather than a hook chopped mid-word.
assert.deepEqual(buildHookSuggestions({ ...input({ finishMarginMs: 2_400 }), maxChars: 10 }), []);

// Underdog: elo comes from the match-time rating, not the live one. changes[] carries
// eloRate *after* the match plus the delta, so edcr started at 1850 and doogile at 2050.
const upset = buildHookSuggestions(
  input({ winner: "edcr" }, {
    changes: [
      { uuid: "uuid-l", eloRate: 1870, change: 20 },
      { uuid: "uuid-r", eloRate: 2030, change: -20 },
    ],
  } as unknown as Partial<MatchInfo>),
);
assert.ok(
  upset.some((t) => t === "The 1850 takes down the 2050"),
  `expected an underdog hook, got ${JSON.stringify(upset)}`,
);

// A forfeit is stated plainly rather than dressed up as a close finish.
assert.ok(
  buildHookSuggestions(input({ finishMarginMs: null }, { forfeited: true })).includes("It ended in a forfeit"),
);

// Never more than the caller asked for.
assert.ok(buildHookSuggestions(input({ leadChanges: 6, deaths: 6, maxSwingMs: 90_000 }), 2).length <= 2);

// --- HOOK_SUGGEST_CMD: the escape hatch for the antigravity CLI ---------------------------

const facts = hookFacts(input());
assert.equal(facts.matchId, 1);
assert.equal(facts.maxChars, MAX);

// The command receives the facts on stdin and returns one suggestion per line. Numbered and
// bulleted lists are tolerated because that is what a model returns unless told twice.
process.env.HOOK_SUGGEST_CMD = `printf '1. Decided at the dragon\\n- A brutal fortress split\\n'`;
assert.deepEqual(await suggestHooksExternally(input()), ["Decided at the dragon", "A brutal fortress split"]);

// Over-budget lines from the command are dropped, same as the built-ins.
process.env.HOOK_SUGGEST_CMD = `printf 'ok short one\\n%s\\n' "$(head -c 200 /dev/zero | tr '\\0' 'x')"`;
assert.deepEqual(await suggestHooksExternally(input()), ["ok short one"]);

// Every failure mode falls back to the built-ins: an empty box is worse than a plainer hook.
process.env.HOOK_SUGGEST_CMD = "false";
assert.equal(await suggestHooksExternally(input()), null);

process.env.HOOK_SUGGEST_CMD = "printf ''";
assert.equal(await suggestHooksExternally(input()), null);

process.env.HOOK_SUGGEST_CMD = "definitely-not-a-real-binary-xyz";
assert.equal(await suggestHooksExternally(input()), null);

// The command must actually be handed the facts, not just invoked.
process.env.HOOK_SUGGEST_CMD = `python3 -c "import json,sys; d=json.load(sys.stdin); print('Match', d['matchId'], 'read ok')"`;
assert.deepEqual(await suggestHooksExternally(input()), ["Match 1 read ok"]);

// Unset means "use the built-ins", not "fail".
delete process.env.HOOK_SUGGEST_CMD;
assert.equal(await suggestHooksExternally(input()), null);

console.log("hooks: all checks passed");
