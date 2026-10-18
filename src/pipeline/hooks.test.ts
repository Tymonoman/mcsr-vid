import assert from "node:assert/strict";
import {
  buildHookSuggestions,
  HOOK_SEED_RANK_ELO,
  hookFacts,
  hookLabelProblem,
  hookSuggestions,
  spoilsTheResult,
  suggestHooksExternally,
  titleEventProblem,
  typedSpoiler,
  type HookInput,
} from "./hooks.js";
import { config } from "../config.js";
import type { MatchMetrics } from "./matchScore.js";
import type { MatchInfo, UserDetails, VersusStats } from "../api/types.js";

/** Budget from a real pair of nicknames: buildTitle("edcr","doogile") gives 34-47. */
const MAX = 47;
const MIN = 34;

/** Elo `changes` that put edcr at 1850 and doogile at 2050 going in. */
const ELO_GAP = {
  changes: [
    { uuid: "uuid-l", eloRate: 1850, change: 20 },
    { uuid: "uuid-r", eloRate: 2050, change: -20 },
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
    panelLeadChanges: 0,
    maxSwingMs: 0,
    deaths: 1,
    deathsByPlayer: { edcr: 1 },
    ...over,
  };
  // hooks.ts's "not a single death" chip now reads `match.timelines` directly (onScreenDeaths,
  // 8 Oct 2026 chip-truth fix), not `metrics.deaths`. Mirroring `metrics.deaths` with that many
  // ordinary death entries by default keeps every test that only sets `deaths` behaving exactly
  // as it did before that fix; a test about hunger resets specifically overrides `timelines` in
  // matchOver instead (see "the death chips read the POV, not just deathKind" below).
  const defaultTimelines = Array.from({ length: metrics.deaths }, (_, i) => ({
    uuid: `uuid-death-${i}`,
    time: 0,
    type: "projectelo.timeline.death",
  }));
  const match = {
    forfeited: false,
    changes: [],
    result: { uuid: null, time: metrics.resultMs },
    players: [],
    timelines: defaultTimelines,
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

// Rewritten 18 Oct 2026 (the operator's complaint: titles were spoiling the match and had
// collapsed into one template). A margin, lead change or death count is no longer a chip at
// all — only a real close finish (under a second), the setting, a forfeit and a real rivalry.

// A close finish is the one case a number is still allowed — and the real margin, not a rounding.
const photo = buildHookSuggestions(input({ finishMarginMs: 58 }));
assert.equal(photo[0], "Decided by 58 milliseconds");

// Grammar bug (6 Oct 2026 panel), still pinned at the new, tighter threshold: a margin that
// rounds to exactly one second must say "1 second", never "1 seconds".
assert.equal(buildHookSuggestions(input({ finishMarginMs: 999 }))[0], "Decided by 1 second");

// ...and singular at one millisecond; a dead heat was decided by nothing, so it gets no chip.
assert.equal(buildHookSuggestions(input({ finishMarginMs: 1 }))[0], "Decided by 1 millisecond");
assert.ok(!buildHookSuggestions(input({ finishMarginMs: 0 }), 10).some((t) => t.startsWith("Decided by")));

// At or past a full second, the match is no longer "really close" (the operator's own bar, 18 Oct
// 2026) — no chip, number or otherwise, however dramatic the old margin/lead/death chips once
// made it look.
for (const finishMarginMs of [1_000, 2_400, 30_000, 120_000, null])
  assert.ok(
    !buildHookSuggestions(input({ finishMarginMs })).some((t) => t.startsWith("Decided by")),
    `no close-finish chip at margin ${finishMarginMs}`,
  );

// The setting is always fair game and never a spoiler.
const seeded = buildHookSuggestions(input({}, { seedType: "DESERT_TEMPLE" }));
assert.ok(seeded.includes("A desert temple seed race"), JSON.stringify(seeded));
// No seed type on the match: no setting chip, not a crash.
assert.deepEqual(buildHookSuggestions(input()), []);

// A margin, lead change or death count is gone for good — not even as a fallback.
for (const over of [
  { leadChanges: 5, panelLeadChanges: 4 },
  { deaths: 7 },
  { maxSwingMs: 90_000 },
  { resultMs: 300_000 },
])
  assert.deepEqual(buildHookSuggestions(input(over)), [], `no chip survives from ${JSON.stringify(over)}`);

// Every suggestion has to fit the title budget, or it cannot be used at all.
for (const text of buildHookSuggestions(input({ finishMarginMs: 58 }, { seedType: "VILLAGE" }))) {
  assert.ok(text.length <= MAX, `"${text}" is ${text.length} chars, over the ${MAX} budget`);
}

// A tiny budget yields nothing rather than a hook chopped mid-word.
assert.deepEqual(buildHookSuggestions({ ...input({ finishMarginMs: 58 }), maxChars: 10 }), []);

// Underdog: suggestions never use seeds, ranks or elo numbers.
const upset = buildHookSuggestions(input({ winner: "edcr" }, ELO_GAP));
assert.ok(
  !upset.some((t) => /#\d+/.test(t) || /seed/i.test(t) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(t)),
  `expected no seed, rank or elo chip, got ${JSON.stringify(upset)}`,
);
// The same question when the favourite wins, so the question never answers itself; only its
// weight differs, which a viewer cannot see.
const favourite = buildHookSuggestions(input({ winner: "doogile" }, ELO_GAP));
assert.ok(
  !favourite.some((t) => /#\d+/.test(t) || /seed/i.test(t) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(t)),
  `expected no seed, rank or elo chip, got ${JSON.stringify(favourite)}`,
);
assert.ok(!upset.concat(favourite).some((t) => /takes down/.test(t)), "no chip names the winner");

// --- Rivalry chips: unaffected by the 18 Oct 2026 rewrite, still a real head-to-head record ---
// A close finish and a rivalry can both show, each still passing every seed/rank/elo check.
const rivalry = buildHookSuggestions(
  input({ winner: "edcr", finishMarginMs: 58 }, ELO_GAP, {
    userLeft: user("edcr", "uuid-l", 4),
    userRight: user("doogile", "uuid-r", 11),
    versus: versus(1, 2),
  }),
  4,
);
assert.deepEqual(rivalry, ["Decided by 58 milliseconds", "Rematch: doogile leads 2-1 this season"]);
assert.ok(
  !rivalry.some((t) => /#\d+/.test(t) || /seed/i.test(t) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(t)),
  "no seed, rank or elo in rivalry chips",
);

{
  // The plain ladder-rank and elo shapes (14 Oct 2026 edge pass); the world's seed type stays fair.
  for (const text of [
    "CAN RANK 1 HOLD ON?",
    "TOP 10 PLAYER IN TROUBLE?",
    "THE 2100 ELO RUNNER?",
    "WORLD NUMBER ONE?",
    "A TOP SEED FALLS?",
  ])
    assert.ok(HOOK_SEED_RANK_ELO.test(text), `"${text}" should read as a seed, rank or elo`);
  // A lone rating, no "elo" after it (15 Oct 2026): the pick model is handed both players' elo.
  for (const text of ["CAN ANYONE STOP THE 2400?", "A 2100 RUNNER'S BEST RUN"])
    assert.ok(HOOK_SEED_RANK_ELO.test(text), `"${text}" is an elo`);
  for (const text of ["Decided by 1500 ms", "Decided by 1500 milliseconds", "A sub-10 to win it"])
    assert.ok(!HOOK_SEED_RANK_ELO.test(text), `"${text}" is not an elo`);
  console.log("OK: a lone elo number is caught, milliseconds are not");
  for (const text of ["Village seed, no mercy", "Same seed, two routes", "Top of the nether"])
    assert.ok(!HOOK_SEED_RANK_ELO.test(text), `"${text}" is not a seed, rank or elo`);
  // A first meeting is in the same band as a close finish.
  assert.deepEqual(buildHookSuggestions(input({ finishMarginMs: 58 }, {}, { versus: versus(0, 0) }), 10), [
    "Decided by 58 milliseconds",
    "Their first 1v1 this season",
  ]);
  // A null margin (a DNF) is normal, not dramatic, and gets no chip of its own any more — the
  // rivalry chip is the only one left standing.
  assert.deepEqual(buildHookSuggestions(input({ finishMarginMs: null }, {}, { versus: versus(1, 2) })), [
    "Rematch: doogile leads 2-1 this season",
  ]);
}

// A playoff game: suggestions never use seeds, ranks or elo (the operator's call, 24 Sept 2026).
{
  const playoff = {
    season: 11,
    round: "Round of 16",
    gameNo: 1,
    bestOf: 5,
    firstTo: 3,
    score: [0, 0] as [number, number],
    seeds: [
      { uuid: "uuid-r", nickname: "doogile", label: "LCQ", seasonEloRate: 2137 },
      { uuid: "uuid-l", nickname: "edcr", label: "#1 seed", seasonEloRate: 2688 },
    ] as [never, never],
  };
  const po = buildHookSuggestions(
    input({}, ELO_GAP, {
      userLeft: user("edcr", "uuid-l", 4),
      userRight: user("doogile", "uuid-r", 11),
      playoff: playoff as unknown as HookInput["playoff"],
    }),
    4,
  );
  assert.ok(
    !po.some((h) => /#\d+/.test(h) || /seed/i.test(h) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(h)),
    po.join(" | "),
  );
  assert.ok(!po.some((h) => h.includes("#")), `no hash in a playoff hook: ${po.join(" | ")}`);
  const seeded = buildHookSuggestions(
    input({}, ELO_GAP, {
      playoff: {
        ...playoff,
        seeds: [
          { uuid: "uuid-l", nickname: "edcr", label: "#3 seed", seasonEloRate: 2600 },
          { uuid: "uuid-r", nickname: "doogile", label: "#12 seed", seasonEloRate: 2300 },
        ],
      } as unknown as HookInput["playoff"],
    }),
    6,
  );
  assert.ok(
    !seeded.some((h) => /#\d+/.test(h) || /seed/i.test(h) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(h)),
    seeded.join(" | "),
  );
  assert.ok(!seeded.some((h) => h.includes("#")), `no hash in playoff hooks: ${seeded.join(" | ")}`);
  const seed9 = buildHookSuggestions(
    input({}, ELO_GAP, {
      playoff: {
        ...playoff,
        seeds: [
          { uuid: "uuid-l", nickname: "edcr", label: "#9 seed", seasonEloRate: 2600 },
          { uuid: "uuid-r", nickname: "doogile", label: "#11 seed", seasonEloRate: 2300 },
        ],
      } as unknown as HookInput["playoff"],
    }),
    6,
  );
  assert.ok(
    !seed9.some((h) => /#\d+/.test(h) || /seed/i.test(h) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(h)),
    seed9.join(" | "),
  );
  assert.ok(!seed9.some((h) => h.includes("#")), `no hash in 9th/11th seed hooks: ${seed9.join(" | ")}`);
  // No head-to-head on a playoff game (15 Oct 2026): "Rematch: edcr leads 2-1" beside "Round of 16
  // | Game 3" reads as the series score, and the generator is not handed the record either.
  const withRecord = input(
    {},
    { type: 3 },
    { playoff: playoff as unknown as HookInput["playoff"], versus: versus(2, 1) },
  );
  const chips = buildHookSuggestions(withRecord, 10);
  assert.ok(!chips.some((h) => /rematch|1v1/i.test(h)), chips.join(" | "));
  assert.equal(hookFacts(withRecord).h2h, null);
  console.log("OK: a playoff game gets no head-to-head chip and no h2h fact");
}

// A tie is still a rivalry, but nobody "leads" it.
// The record is one season's (getVersus): "all time" and a bare "first 1v1" claimed more than that.
assert.equal(
  buildHookSuggestions(input({}, ELO_GAP, { versus: versus(2, 2) }))[0],
  "Rematch: 2-2 this season",
);

// One-sided history is not a rivalry: no rematch chip. A first meeting gets its own chip, but
// below a close finish — it drew 1.5x the median on the competitor that uses it, while their
// close-finish titles topped the channel.
for (const record of [versus(3, 0), versus(0, 0)]) {
  const none = buildHookSuggestions(input({}, {}, { versus: record }));
  assert.ok(!none.some((t) => t.startsWith("Rematch")), `unexpected h2h chip in ${JSON.stringify(none)}`);
}
assert.ok(
  !buildHookSuggestions(input({}, {}, { versus: versus(3, 0) })).includes("Their first 1v1 this season"),
);
const first = buildHookSuggestions(input({ finishMarginMs: 58 }, {}, { versus: versus(0, 0) }));
assert.equal(first[0], "Decided by 58 milliseconds");
assert.equal(first[1], "Their first 1v1 this season");
console.log('OK: the head-to-head chips say "this season", the record they read');

// `versus` is optional — every caller that predates it still works, and just loses that chip.
const noVersus = buildHookSuggestions(input({ finishMarginMs: 58 }));
assert.equal(noVersus[0], "Decided by 58 milliseconds");
assert.ok(!noVersus.some((t) => t.startsWith("Rematch")));

// Ranks a viewer cannot place are two numbers, not a matchup — no chip here ever reads an elo rank.
assert.ok(
  !buildHookSuggestions(
    input({}, {}, { userLeft: user("edcr", "uuid-l", 843), userRight: user("doogile", "uuid-r", 1291) }),
  ).some((t) => t.includes("#843")),
);

// With no rivalry, no setting and no close finish, there is nothing to say at all.
assert.deepEqual(buildHookSuggestions(input({ finishMarginMs: 2_400 })), []);

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
const shortBudget = buildHookSuggestions({ ...input({}, ELO_GAP, { versus: versus(1, 2) }), maxChars: 12 });
assert.deepEqual(shortBudget, []);
assert.ok(
  !shortBudget.some((t) => /#\d+/.test(t) || /seed/i.test(t) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(t)),
);

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

// getVersus counts this match too: a ranked first meeting the right player won comes back 0-1. Both the generator's facts and the chips must read it as the
// first 1v1, not a one-sided record that tells the generator who won (14125831).
{
  const wonByRight = input(
    {},
    { type: 2, result: { uuid: "uuid-r", time: 700_000 } },
    { versus: versus(0, 1) },
  );
  assert.deepEqual(hookFacts(wonByRight).h2h, { left: 0, right: 0 });
  assert.ok(buildHookSuggestions(wonByRight, 10).includes("Their first 1v1 this season"));
}

// A forfeit is stated plainly rather than dressed up as a close finish.
assert.ok(
  buildHookSuggestions(input({ finishMarginMs: null }, { forfeited: true })).includes(
    "It ended in a forfeit",
  ),
);
// ...nor as a pace record: on a forfeit `resultMs` is the forfeit's moment, so a 5:40 forfeit
// is no "sub-6 to win it".
const ff = buildHookSuggestions(input({ resultMs: 340_000, finishMarginMs: null }, { forfeited: true }));
assert.ok(!ff.some((t) => /sub-\d+ to win/i.test(t)), `no pace chip on a forfeit: ${ff.join(" | ")}`);
assert.ok(ff.includes("It ended in a forfeit"));

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

// External suggestions with seeds, ladder ranks or elo numbers are filtered out.
process.env.HOOK_SUGGEST_CMD = `printf 'Decided at the dragon\\n#4 vs #11\\n2050 vs 1850\\n7th seed vs LCQ\\nCan the 1850 take down the 2050?\\n'`;
assert.deepEqual(await suggestHooksExternally(input()), ["Decided at the dragon"]);

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

// The generator is never handed the result, and never trusted to keep it either.
{
  const facts = hookFacts(input()) as Record<string, unknown>;
  assert.ok(!("winner" in facts), "hookFacts must not name the winner");
  assert.ok(!JSON.stringify(facts).includes('"winner"'), "nor nest it anywhere");

  for (const spoiler of [
    "Infume WINS from 20 seconds down",
    "doogile takes the win on the last portal",
    "edcr chokes the dragon fight",
    "BeefSalad lost this at the bastion",
    // Placements tell a bracket's outcome (23 Sept 2026, a live title).
    "WINNER vs 3rd PLACE",
    "3RD PLACE vs THE LCQ",
    "the runner-up returns",
    "two finalists on one seed",
    "SEASON 11 CHAMPION vs #14",
    // A sweep is a best-of's result, nickname or not (24 Sept 2026 audit).
    "PLAYOFFS | SWEPT vs TAS",
    "TAS vs SWEPT",
    "doogile sweeps the round of 16",
    // Not the sanctioned pace idiom ("A sub-N to win it") — a real nickname next to "to win"
    // language, which a blanket `\bto win\b` strip briefly let through (6 Oct 2026).
    "doogile battles back to win it",
    // A name next to a finishing verb, none of them "win" (14 Oct 2026 edge pass). The last one
    // carries the pace idiom mid-line: only a leading "A sub-N to win it" is the stake.
    "EDCR TAKES THE MATCH",
    "EDCR TAKES GAME 3",
    "EDCR FINISHES FIRST",
    "EDCR SEALS IT",
    "EDCR STEALS IT AT THE END",
    "DOOGILE FALLS SHORT",
    "EDCR ADVANCES",
    "THE UPSET NOBODY SAW COMING",
    "EDCR GOES SUB-8 TO WIN IT",
    // ...and only when it is the whole segment: a name after it is still read (15 Oct 2026).
    "A SUB-8 TO WIN IT FOR DOOGILE",
    "A SUB-8 TO WIN IT: DOOGILE'S RUN",
    // How it went is the result too (14 Oct 2026 edge run: all eight passed every check).
    "HUGE UPSET",
    "THE UPSET OF THE SEASON",
    "EDCR DOMINATES",
    "DOOGILE'S REVENGE",
    "THE LEAD HOLDS",
    "EDCR NEVER LOOKED BACK",
    "DOOGILE OUTPLAYS EDCR",
    "THE UNDERDOG PREVAILS",
  ]) {
    assert.ok(spoilsTheResult(spoiler), `should be rejected: ${spoiler}`);
  }
  for (const safe of [
    "Can the 1789 take down the 2080?",
    // A stake, not a result: what winning takes (a hook the model proposed, 24 Sept 2026).
    "A SUB-8 TO WIN IT",
    "LOVERBOY VS ROBLOX KID",
    "Rematch: doogile leads 2-1 this season",
    "Decided by 2.8 seconds",
    "The lead changed 3 times",
    "Who wins this one?",
    "Can the 3rd place take down the champion?",
    "A sub-7 to win it",
    // The full title Test & Compare checks still leads with the stake.
    "A SUB-8 TO WIN IT | doogile vs edcr #mcsr #minecraft",
    "A SUB-9 TO WIN IT | lowkey vs Infume | MCSR Ranked Season 11 Playoffs | Grand Finals",
    // The upset hook is a question.
    "THE UPSET NOBODY SAW COMING?",
    "An upset in the making?",
    "UPSET?",
    "Does the lead ever settle?",
    // "advanced" is a result only as "advanced to".
    "ADVANCED NETHER ROUTE",
  ]) {
    assert.ok(!spoilsTheResult(safe), `should be allowed: ${safe}`);
  }
  // The Title & description fold: only what the operator typed is judged, never the round name.
  const generated = "<HOOK> | Aquacorde vs doogile | MCSR Ranked Season 11 Playoffs | 3rd Place\n\nnote";
  assert.equal(
    typedSpoiler(
      "PLAYOFFS | SWEPT vs TAS | Aquacorde vs doogile | MCSR Ranked Season 11 Playoffs | 3rd Place",
      generated,
    ),
    "SWEPT vs TAS",
  );
  assert.equal(
    typedSpoiler("Can the 1789 take down the 2080? | Aquacorde vs doogile | 3rd Place", generated),
    null,
  );
  assert.equal(typedSpoiler("TAS vs SWEPT | a vs b", "", "TAS vs SWEPT | a vs b"), null, "already on disk");
}

// A match's own runner named at the End is the result (15 Oct 2026: "Infume on sub-8 pace at the
// End" passed every check and auto-saved as 13140492's Short hook; Infume won).
{
  const players = [{ nickname: "Feinberg" }, { nickname: "Infume" }];
  for (const spoiler of [
    "INFUME ON SUB-8 PACE AT THE END",
    "Infume on sub-8 pace at the End",
    "FEINBERG'S ZERO CYCLE",
    "INFUME AT THE DRAGON ON 1 HEART",
    "FEINBERG ON RECORD PACE",
    "INFUME CLOSING IT OUT",
  ])
    assert.ok(spoilsTheResult(spoiler, players), `should be rejected: ${spoiler}`);
  // The broadcast's spelling is the runner too (titleNames, DEFAULTS: lowk3y_ is "lowkey").
  assert.ok(
    spoilsTheResult("LOWKEY GOES FOR THE ZERO CYCLE", [{ nickname: "lowk3y_" }, { nickname: "Infume" }]),
  );
  for (const safe of [
    "A SUB-8 RACE TO THE END", // 13140492's own long-form hook: names nobody
    "INFUME AHEAD AT THE BASTION", // a leader mid-race, no endgame
    "Can Infume finish before Feinberg?", // a question (14035423's)
    "FEINBERGER AT THE END", // not a whole-word player
    "Rematch: Infume leads 3-2 all time",
  ])
    assert.ok(!spoilsTheResult(safe, players), `should be allowed: ${safe}`);
  assert.ok(!spoilsTheResult("INFUME ON SUB-8 PACE AT THE END"), "no players given, no name known");
  console.log(
    "OK: a match's runner named at the End or on a finishing pace spoils; nobody named, mid-race or a question does not",
  );
}

// --- hookLabelProblem: never a nickname, label or epithet for a runner (2 Oct 2026) -----------
// "LCQ vs YN" and "ASIAN VS CARNIVORE" both went out this way and drew public objection from the
// runners named.
{
  const LABEL = "names a runner with a label: runners have objected to this (2 Oct 2026)";
  // A denied word is a label on its own, "vs" or not, match or no match.
  for (const denied of ["LCQ vs YN", "ASIAN VS CARNIVORE", "the ASIAN player", "YN"]) {
    assert.equal(hookLabelProblem(denied), LABEL, denied);
  }
  // No match context: nothing to compare an "X vs Y" pair against, so it passes unless a denied
  // word already caught it above.
  assert.equal(hookLabelProblem("TAS vs CATBOY"), null, "no players given");
  assert.equal(hookLabelProblem("Decided by 2.4 seconds"), null, "not even shaped like a pair");

  const players = [user("edcr", "uuid-l"), user("doogile", "uuid-r")];
  assert.equal(hookLabelProblem("TAS vs CATBOY", players), LABEL, "neither side is a real player");
  assert.equal(hookLabelProblem("edcr vs CATBOY", players), LABEL, "one side is still invented");
  assert.equal(hookLabelProblem("edcr vs doogile", players), null, "the real nicknames, not a label");
  assert.equal(hookLabelProblem("DOOGILE vs EDCR", players), null, "case-insensitive, either order");
  // Every spelling of "vs", and any number of sides (14 Oct 2026 review: "v."/"versus" and a third
  // side slipped through an exact-two, literal-"vs" split).
  for (const label of [
    "CARNIVORE v. VEGAN",
    "LOVERBOY VERSUS TAS",
    "LOVERBOY V TAS",
    "LOVERBOY vs TAS vs THE CLOCK",
  ]) {
    assert.equal(hookLabelProblem(label, players), LABEL, label);
  }
  assert.equal(hookLabelProblem("edcr versus doogile", players), null, "versus, real nicknames");
  assert.equal(hookLabelProblem("EDCR v. DOOGILE", players), null, "v., real nicknames");
  assert.equal(hookLabelProblem("1v1 to the dragon", players), null, "no spaces round the v, no split");
  assert.equal(hookLabelProblem("Their first 1v1", players), null, "1v1 is not a pair");

  // titleNames: the broadcast's spelling is not a label either (Pinne is Skycrab).
  const broadcast = [user("Pinne", "uuid-p"), user("lowk3y_", "uuid-k")];
  assert.equal(hookLabelProblem("Skycrab vs lowkey", broadcast), null, "titleNames spelling, not a label");

  // runnerNicknames (18 Oct 2026): the operator's own pair is operator-authored, not a label —
  // titleOptions.ts's Option 1 is code assembling exactly this.
  const savedNicks = config.runnerNicknames;
  config.runnerNicknames = { edcr: "THE WIZARD", doogile: "SPEEDY" };
  assert.equal(
    hookLabelProblem("THE WIZARD vs SPEEDY", players),
    null,
    "the operator's own runnerNicknames pair, not a label",
  );
  assert.equal(
    hookLabelProblem("the wizard vs speedy", players),
    null,
    "matched case-insensitively, either case",
  );
  // Still refused when only one side is the operator's nickname and the other is invented.
  assert.equal(hookLabelProblem("THE WIZARD vs CATBOY", players), LABEL);
  config.runnerNicknames = savedNicks;
  console.log("OK: hookLabelProblem rejects a denied word and an invented vs-pair, never a real one");
}

// --- titleEventProblem: never about what happens in the match (18 Oct 2026) -------------------
{
  for (const spoiler of [
    "THE LEAD NEVER SETTLES",
    "A COMEBACK FOR THE AGES",
    "CAN THEY OVERTAKE HIM?",
    "NOT A SINGLE DEATH",
    "A HEART-POUNDING RESET",
    "THE SPLIT THAT DECIDED IT",
    "RECORD PACE ALL THE WAY",
    "DOES THE MARGIN HOLD?",
  ])
    assert.ok(
      titleEventProblem(spoiler, { marginMs: null }) !== null,
      `should be refused as an in-match event: ${spoiler}`,
    );
  // A digit is refused unless the match was decided inside a second.
  assert.ok(
    titleEventProblem("A 24-SECOND RACE", { marginMs: 24_000 }) !== null,
    "a far margin, digits refused",
  );
  assert.ok(
    titleEventProblem("A 24-SECOND RACE", { marginMs: null }) !== null,
    "no margin at all, digits refused",
  );
  assert.equal(
    titleEventProblem("DECIDED BY 320", { marginMs: 320 }),
    null,
    "a real close finish may use its own number",
  );
  assert.ok(
    titleEventProblem("DECIDED BY 320", { marginMs: 1_000 }) !== null,
    "exactly one second is not under a second",
  );
  for (const safe of [
    "THE DUALITY OF MAN",
    "WHO BLINKS FIRST?",
    "A DRAGON FIGHT FOR TWO",
    "LAVA DOESN'T FORGIVE",
  ])
    assert.equal(titleEventProblem(safe, { marginMs: null }), null, `should be allowed: ${safe}`);
  console.log("OK: titleEventProblem refuses in-match events and non-close-finish digits");
}

// The external generator is held to the same rule as the built-ins.
process.env.HOOK_SUGGEST_CMD = `printf 'Decided at the dragon\\nLCQ vs YN\\nASIAN VS CARNIVORE\\n'`;
assert.deepEqual(await suggestHooksExternally(input()), ["Decided at the dragon"]);
delete process.env.HOOK_SUGGEST_CMD;
console.log("OK: HOOK_SUGGEST_CMD is held to the no-label rule too");

// hookSuggestions itself is held to the same rule, whatever produced the chip (2 Oct 2026) — the
// render pipeline's cold-start default (pipeline.ts) calls this function directly, never through
// the dashboard's own chip filter, so this is the one place that has to catch "TAS vs UNC" (the
// real string match-13223455.title.txt carried as its first suggestion).
process.env.HOOK_SUGGEST_CMD = `printf 'TAS vs UNC\\nDecided at the dragon\\n'`;
assert.deepEqual(
  await hookSuggestions(input()),
  ["Decided at the dragon"],
  "edcr vs doogile: TAS/UNC is neither",
);
delete process.env.HOOK_SUGGEST_CMD;
// Unset, the built-ins never produce a labelled chip anyway — hookSuggestions changes nothing for them.
assert.deepEqual(await hookSuggestions(input({ finishMarginMs: 58 })), ["Decided by 58 milliseconds"]);
console.log("OK: hookSuggestions filters a labelled chip too, not just suggestHooksExternally");
