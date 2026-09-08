import assert from "node:assert/strict";
import { buildHookSuggestions, hookFacts, suggestHooksExternally, type HookInput } from "./hooks.js";
import type { MatchMetrics } from "./matchScore.js";
import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

/** Budget from a real pair of nicknames: buildTitle("edcr","doogile") gives 34-47. */
const MAX = 47;
const MIN = 34;

/** Elo `changes` that put edcr at 1850 and doogile at 2050 going in. */
const ELO_GAP = {
  changes: [
    { uuid: "uuid-l", eloRate: 1870, change: 20 },
    { uuid: "uuid-r", eloRate: 2030, change: -20 },
  ],
} as unknown as Partial<MatchInfo>;

const versus = (leftWins: number, rightWins: number): VersusStats =>
  ({ results: { ranked: { "uuid-l": leftWins, "uuid-r": rightWins } } }) as unknown as VersusStats;

function input(
  over: Partial<MatchMetrics> = {},
  matchOver: Partial<MatchInfo> = {},
  extra: Partial<HookInput> = {},
): HookInput {
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
  return {
    metrics,
    match,
    userLeft: user("edcr", "uuid-l"),
    userRight: user("doogile", "uuid-r"),
    maxChars: MAX,
    minChars: MIN,
    ...extra,
  };
}

const user = (nickname: string, uuid: string, eloRank: number | null = null): UserDetails =>
  ({ nickname, uuid, eloRate: 1900, eloRank }) as unknown as UserDetails;

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
const upset = buildHookSuggestions(input({ winner: "edcr" }, ELO_GAP));
assert.ok(
  upset.some((t) => t === "Can the 1850 take down the 2050?"),
  `expected an underdog hook, got ${JSON.stringify(upset)}`,
);
// The same question when the favourite wins, so the question never answers itself; only its
// weight differs, which a viewer cannot see.
const favourite = buildHookSuggestions(input({ winner: "doogile" }, ELO_GAP));
assert.ok(
  favourite.some((t) => t === "Can the 1850 take down the 2050?"),
  `the question must not depend on who won, got ${JSON.stringify(favourite)}`,
);
assert.ok(!upset.concat(favourite).some((t) => /takes down/.test(t)), "no chip names the winner");

// --- Rivalry framing outranks description ------------------------------------------------
// Measured on the first seven uploads: rivalry hooks took 9.36% CTR, descriptive ones 2.25%.
// So with rivalry data present a descriptive chip must never reach the top of the list — and
// the top one is what public/app.js drops into the hook input's placeholder.
const rivalry = buildHookSuggestions(
  input({ winner: "edcr", finishMarginMs: 2_400, leadChanges: 4 }, ELO_GAP, {
    userLeft: user("edcr", "uuid-l", 4),
    userRight: user("doogile", "uuid-r", 11),
    versus: versus(1, 2),
  }),
  4,
);
assert.deepEqual(rivalry, [
  "Rematch: doogile leads 2-1",
  "Can the 1850 take down the 2050?",
  "#4 vs #11",
  "2050 vs 1850",
]);

// A tie is still a rivalry, but nobody "leads" it.
assert.equal(buildHookSuggestions(input({}, ELO_GAP, { versus: versus(2, 2) }))[0], "Rematch: 2-2 all time");

// One-sided history is not a rivalry: no rematch chip. A first meeting gets its own chip, but
// below a close finish — it drew 1.5x the median on the competitor that uses it, while their
// close-finish titles topped the channel.
for (const record of [versus(3, 0), versus(0, 0)]) {
  const none = buildHookSuggestions(input({}, {}, { versus: record }));
  assert.ok(!none.some((t) => t.startsWith("Rematch")), `unexpected h2h chip in ${JSON.stringify(none)}`);
}
assert.ok(!buildHookSuggestions(input({}, {}, { versus: versus(3, 0) })).includes("Their first 1v1"));
const first = buildHookSuggestions(input({ finishMarginMs: 2_400 }, {}, { versus: versus(0, 0) }));
assert.equal(first[0], "Decided by 2.4 seconds");
assert.equal(first[1], "Their first 1v1");

// The finishing minute is the hook, not a fixed "sub-10": 6:51 is a sub-7, 7:00 is a sub-8.
assert.ok(buildHookSuggestions(input({ resultMs: 411_000 })).includes("A sub-7 to win it"));
assert.ok(buildHookSuggestions(input({ resultMs: 420_000 })).includes("A sub-8 to win it"));
assert.ok(buildHookSuggestions(input({ resultMs: 599_000 })).includes("A sub-10 to win it"));
const fast = buildHookSuggestions(input({ resultMs: 411_000, leadChanges: 3 }));
assert.ok(fast.indexOf("A sub-7 to win it") < fast.indexOf("The lead changed 3 times"), JSON.stringify(fast));

// `versus` is optional — every caller that predates it still works, and just loses that chip.
const noVersus = buildHookSuggestions(input({ finishMarginMs: 2_400 }));
assert.equal(noVersus[0], "Decided by 2.4 seconds");
assert.ok(!noVersus.some((t) => t.startsWith("Rematch")));

// Ranks a viewer cannot place are two numbers, not a matchup.
assert.ok(
  !buildHookSuggestions(
    input({}, {}, { userLeft: user("edcr", "uuid-l", 843), userRight: user("doogile", "uuid-r", 1291) }),
  ).some((t) => t.includes("#843")),
);

// Descriptive chips are still there underneath, and still lead when there is no rivalry to
// state — a match between two unranked players of equal elo is exactly that case.
const plain = buildHookSuggestions(input({ finishMarginMs: 2_400, leadChanges: 4, deaths: 0 }));
assert.equal(plain[0], "Decided by 2.4 seconds");
assert.ok(plain.includes("The lead changed 4 times"));
assert.ok(plain.includes("Not a single death between them"));

// The budget applies to rivalry chips too: an over-long rematch line is dropped, not truncated.
const longName = buildHookSuggestions(
  input(
    {},
    {},
    {
      userRight: user("a-nickname-far-past-the-title-budget", "uuid-r"),
      versus: versus(1, 2),
    },
  ),
);
for (const text of longName) assert.ok(text.length <= MAX && text.length >= 8, text);
assert.ok(!longName.some((t) => t.startsWith("Rematch")));

// Length still only breaks ties: the in-band chip wins between equal weights, never against a
// heavier one.
for (const text of rivalry) assert.ok(text.length <= MAX, `"${text}" is over the ${MAX} budget`);
assert.deepEqual(buildHookSuggestions({ ...input({}, ELO_GAP, { versus: versus(1, 2) }), maxChars: 12 }), [
  "2050 vs 1850",
]);

// hookFacts carries the same rivalry facts, so an external generator sees what the built-ins do.
const rivalryFacts = hookFacts(
  input({}, ELO_GAP, {
    userLeft: user("edcr", "uuid-l", 4),
    userRight: user("doogile", "uuid-r", 11),
    versus: versus(1, 2),
  }),
);
assert.deepEqual(rivalryFacts.rank, { left: 4, right: 11 });
assert.deepEqual(rivalryFacts.h2h, { left: 1, right: 2 });
assert.equal(hookFacts(input()).h2h, null);

// A forfeit is stated plainly rather than dressed up as a close finish.
assert.ok(
  buildHookSuggestions(input({ finishMarginMs: null }, { forfeited: true })).includes(
    "It ended in a forfeit",
  ),
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
