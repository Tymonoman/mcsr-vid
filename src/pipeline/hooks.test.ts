import assert from "node:assert/strict";
import {
  buildHookSuggestions,
  HOOK_SEED_RANK_ELO,
  hookFacts,
  hookLabelProblem,
  hookSuggestions,
  spoilsTheResult,
  suggestHooksExternally,
  typedSpoiler,
  type HookInput,
} from "./hooks.js";
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

// A photo finish is the whole story and must lead. The number is the real margin, not a
// rounding — a hook that overstates the match is worse than no hook.
const photo = buildHookSuggestions(input({ finishMarginMs: 2_400 }));
assert.equal(photo[0], "Decided by 2.4 seconds");

// A whole second renders without a trailing ".0".
assert.equal(buildHookSuggestions(input({ finishMarginMs: 2_000 }))[0], "Decided by 2 seconds");

// Grammar bug (6 Oct 2026 panel): a margin that rounds to exactly one second must say "1 second",
// never "1 seconds" (seconds() used to strip ".0" and leave the plural word behind — the exact
// "low quality" look viewers reported). A real case: match 12730175's 1.03s dragon-death gap.
assert.equal(buildHookSuggestions(input({ finishMarginMs: 1_033 }))[0], "Decided by 1 second");
assert.equal(buildHookSuggestions(input({ finishMarginMs: 1_000 }))[0], "Decided by 1 second");

// Sub-100ms is exact milliseconds, not a rounded-up "0.1 seconds" that overstates the margin
// 1.7x (accuracy panel, 6 Oct 2026; the channel's own past title was "58 MILLISECONDS").
assert.equal(buildHookSuggestions(input({ finishMarginMs: 58 }))[0], "Decided by 58 milliseconds");
// ...and singular at one (14 Oct 2026 edge run: "Decided by 1 milliseconds"); a dead heat was
// decided by nothing, so it gets no "Decided by" chip at all, never "0 milliseconds".
assert.equal(buildHookSuggestions(input({ finishMarginMs: 1 }))[0], "Decided by 1 millisecond");
assert.ok(!buildHookSuggestions(input({ finishMarginMs: 0 }), 10).some((t) => t.startsWith("Decided by")));

// 3-10s margins now state the same subject ("Decided by"), never a bare "N seconds apart" with
// nothing saying it is the finish (click panel, 6 Oct 2026: every such hook was dropped).
assert.equal(buildHookSuggestions(input({ finishMarginMs: 5_000 }))[0], "Decided by 5 seconds");

// Ranking: a 4-lead-change race outranks the deathless note that also applies to it.
const chaotic = buildHookSuggestions(input({ panelLeadChanges: 4, deaths: 0, finishMarginMs: 30_000 }));
assert.equal(chaotic[0], "Does the lead ever settle?");
assert.ok(chaotic.includes("Not a single death between them"));

// The death chips read what the POV actually shows, not just `deathKind`'s "real death" label
// (8 Oct 2026 chip-truth fix): matchScore.ts's own `deaths` still counts real deaths only (a
// hunger reset is routine there, 26 Sept 2026), but the viewer still watches a death screen for
// one, so "not a single death" and the "N deaths" count both read `onScreenDeaths(match)` —
// real cases: 12730175 (five hunger resets, fired "not a single death" under the old code),
// 13766294 (one).
const resetTimelines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    uuid: i % 2 === 0 ? "uuid-l" : "uuid-r",
    time: i * 10_000,
    type: "projectelo.timeline.death_spawnpoint",
  }));
const resets = input(
  { deaths: 0, deathsByPlayer: { edcr: 0, doogile: 0 } },
  { timelines: resetTimelines(5) },
);
assert.ok(
  !buildHookSuggestions(resets).includes("Not a single death between them"),
  'five on-screen resets are not "not a single death" (12730175)',
);
assert.ok(
  !buildHookSuggestions(resets).some((t) => /\d deaths/.test(t)),
  "0 real deaths never reaches the >=4 chip either, resets or not",
);
assert.equal(hookFacts(resets).deaths, 0, "the external generator still gets the real-death count");

const oneReset = input({ deaths: 0 }, { timelines: resetTimelines(1) });
assert.ok(
  !buildHookSuggestions(oneReset).includes("Not a single death between them"),
  'one on-screen reset is not "not a single death" either (13766294)',
);

// Genuinely no on-screen death (the default mirrors `deaths: 0` with none at all) is still
// "not a single death".
assert.ok(buildHookSuggestions(input({ deaths: 0 })).includes("Not a single death between them"));

assert.ok(
  buildHookSuggestions(input({ deaths: 4, finishMarginMs: 5_000 })).includes("4 deaths and still this close"),
);
// "Still this close" takes the "Decided by" chip's <10s bar: not the default 30s, a 2-minute
// finish, or a DNF.
for (const finishMarginMs of [30_000, 120_000, null])
  assert.ok(
    !buildHookSuggestions(input({ deaths: 4, finishMarginMs })).some((t) => /still this close/.test(t)),
    `no "still this close" at margin ${finishMarginMs}`,
  );

// A DNF is normal (the loser stops once the winner is done), so it must not outrank real drama.
const dnf = buildHookSuggestions(input({ finishMarginMs: null, panelLeadChanges: 3 }));
assert.equal(dnf[0], "Does the lead ever settle?");
// "killed", not "reached": a null margin only means the loser never killed the dragon, not that
// they never got there — accuracy panel, 6 Oct 2026 (match 12396259: the loser entered the End
// 1.4s behind and died in the dragon fight, so "never reached" read as false on screen).
assert.ok(dnf.includes("One of them never killed the dragon"));

// Every suggestion has to fit the title budget, or it cannot be used at all.
for (const text of buildHookSuggestions(input({ leadChanges: 5, deaths: 7, maxSwingMs: 90_000 }))) {
  assert.ok(text.length <= MAX, `"${text}" is ${text.length} chars, over the ${MAX} budget`);
}

// A tiny budget yields nothing rather than a hook chopped mid-word.
assert.deepEqual(buildHookSuggestions({ ...input({ finishMarginMs: 2_400 }), maxChars: 10 }), []);

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

// --- The stake outranks the rivalry ------------------------------------------------------
// What the match turns on outranks the two nicknames (see hooks.ts, 30 Sept 2026), so with a
// head-to-head record present the top chip is still a stake — and the top one is what
// public/app.js drops into the hook input's placeholder.
const rivalry = buildHookSuggestions(
  input({ winner: "edcr", finishMarginMs: 2_400, panelLeadChanges: 4 }, ELO_GAP, {
    userLeft: user("edcr", "uuid-l", 4),
    userRight: user("doogile", "uuid-r", 11),
    versus: versus(1, 2),
  }),
  4,
);
assert.deepEqual(rivalry, [
  "Decided by 2.4 seconds",
  "Does the lead ever settle?",
  "Rematch: doogile leads 2-1 this season",
]);
assert.ok(
  !rivalry.some((t) => /#\d+/.test(t) || /seed/i.test(t) || /\b\d{3,4}\b[^\d]+\b\d{3,4}\b/.test(t)),
  "no seed, rank or elo in rivalry chips",
);

// Every stake chip sits above both head-to-head chips, down to the weakest ("not a single
// death"); the rivalry still beats the dull fallback of a DNF. The rematch line is one season's
// record (the API keeps no all-time one), so it may not lead. The house rules
// hold for each of them.
{
  // `winner` defaults to "edcr" (see input()); doogile led one split by 65s and did not go on to
  // win it, so that is the lead actually lost — not a bare maxSwingMs delta (6 Oct 2026 panel: the
  // old maxSwingMs-only version fired just as readily when a leader simply pulled further ahead).
  const both = buildHookSuggestions(
    input(
      {
        finishMarginMs: 2_400,
        leadChanges: 4,
        panelLeadChanges: 4,
        deaths: 0,
        resultMs: 411_000,
        splits: [{ label: "Test", aMs: null, bMs: null, gapMs: 65_000, leader: "doogile" }],
      },
      ELO_GAP,
      { versus: versus(1, 2) },
    ),
    10,
  );
  assert.deepEqual(both, [
    "Decided by 2.4 seconds",
    "A sub-7 to win it",
    "Does the lead ever settle?",
    "Can a 1:05 lead survive?",
    "Not a single death between them",
    "Rematch: doogile leads 2-1 this season",
  ]);
  for (const text of both) {
    assert.ok(!spoilsTheResult(text), `"${text}" gives the result away`);
    assert.ok(!HOOK_SEED_RANK_ELO.test(text), `"${text}" uses a seed, rank or elo`);
  }
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
  // A first meeting is in the same band: under the stakes, over the fallback.
  assert.deepEqual(
    buildHookSuggestions(input({ finishMarginMs: 2_400, deaths: 0 }, {}, { versus: versus(0, 0) }), 10),
    ["Decided by 2.4 seconds", "Not a single death between them", "Their first 1v1 this season"],
  );
  assert.deepEqual(buildHookSuggestions(input({ finishMarginMs: null }, {}, { versus: versus(1, 2) })), [
    "Rematch: doogile leads 2-1 this season",
    "One of them never killed the dragon",
  ]);
}

// --- The swing/comeback fix: only a real reversal, never a leader pulling further ahead --------
// (6 Oct 2026 panel: "A M:SS lead, gone" fired on 5 real matches where the leader led every split
// and won — the "swing" was the lead growing, not collapsing. Matches 13301662/13766294/13333220.)
{
  // doogile leads one split by a lot, but doogile is also the winner: no lead was ever lost.
  const grew = buildHookSuggestions(
    input({
      winner: "doogile",
      leadChanges: 0,
      splits: [{ label: "Test", aMs: null, bMs: null, gapMs: 97_600, leader: "doogile" }],
    }),
  );
  assert.ok(
    !grew.some((t) => /lead survive/.test(t)),
    `a leader who wins must not get a "lead lost" chip: ${JSON.stringify(grew)}`,
  );

  // edcr (the default winner) trailed by 1:36 at one split and still won: that lead really was
  // lost, and the chip quotes the real split gap, not an arbitrary consecutive-split delta.
  const lost = buildHookSuggestions(
    input({
      leadChanges: 1,
      splits: [{ label: "Test", aMs: null, bMs: null, gapMs: 96_600, leader: "doogile" }],
    }),
  );
  assert.ok(lost.includes("Can a 1:36 lead survive?"), JSON.stringify(lost));

  // The overlay panel never shows "Bastion loot" or "Blaze rod" (overlayProps.ts's SPLIT_EVENTS
  // has only 6 rows: Nether enter, Bastion enter, Fortress, Blind travel, Stronghold, End enter).
  // A bigger gap at one of the two off-panel splits must not be quoted — live-verified on match
  // 13705580 (6 Oct 2026): "Bastion loot" showed a 2:36 gap, but the panel's own "Blind travel"
  // row shows 1:36, which is the real, checkable fact a viewer can confirm on screen.
  const offPanel = buildHookSuggestions(
    input({
      leadChanges: 1,
      splits: [
        { label: "Bastion loot", aMs: null, bMs: null, gapMs: 156_762, leader: "doogile" },
        { label: "Blind travel", aMs: null, bMs: null, gapMs: 96_613, leader: "doogile" },
      ],
    }),
  );
  assert.ok(
    offPanel.includes("Can a 1:36 lead survive?"),
    `must quote the panel-visible split, not the bigger off-panel one: ${JSON.stringify(offPanel)}`,
  );
  assert.ok(
    !offPanel.some((t) => /2:36/.test(t)),
    `must not quote an off-panel gap: ${JSON.stringify(offPanel)}`,
  );

  // Under a minute: the shorter, second-tier phrasing, still a question.
  const lostSmall = buildHookSuggestions(
    input({
      leadChanges: 1,
      splits: [{ label: "Test", aMs: null, bMs: null, gapMs: 48_000, leader: "doogile" }],
    }),
  );
  assert.ok(lostSmall.includes("Can a 48-second lead survive?"), JSON.stringify(lostSmall));
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
assert.equal(buildHookSuggestions(input({}, ELO_GAP, { versus: versus(2, 2) }))[0], "Rematch: 2-2 this season");

// One-sided history is not a rivalry: no rematch chip. A first meeting gets its own chip, but
// below a close finish — it drew 1.5x the median on the competitor that uses it, while their
// close-finish titles topped the channel.
for (const record of [versus(3, 0), versus(0, 0)]) {
  const none = buildHookSuggestions(input({}, {}, { versus: record }));
  assert.ok(!none.some((t) => t.startsWith("Rematch")), `unexpected h2h chip in ${JSON.stringify(none)}`);
}
assert.ok(!buildHookSuggestions(input({}, {}, { versus: versus(3, 0) })).includes("Their first 1v1 this season"));
const first = buildHookSuggestions(input({ finishMarginMs: 2_400 }, {}, { versus: versus(0, 0) }));
assert.equal(first[0], "Decided by 2.4 seconds");
assert.equal(first[1], "Their first 1v1 this season");
console.log('OK: the head-to-head chips say "this season", the record they read');

// The finishing minute is the hook, not a fixed "sub-10": 6:51 is a sub-7, 7:00 is a sub-8.
assert.ok(buildHookSuggestions(input({ resultMs: 411_000 })).includes("A sub-7 to win it"));
assert.ok(buildHookSuggestions(input({ resultMs: 420_000 })).includes("A sub-8 to win it"));
assert.ok(buildHookSuggestions(input({ resultMs: 599_000 })).includes("A sub-10 to win it"));
const fast = buildHookSuggestions(input({ resultMs: 411_000, panelLeadChanges: 3 }));
assert.ok(
  fast.indexOf("A sub-7 to win it") < fast.indexOf("Does the lead ever settle?"),
  JSON.stringify(fast),
);

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

// The stake chips are the same without a rivalry to state — a match with no head-to-head record
// fetched is exactly that case.
const plain = buildHookSuggestions(input({ finishMarginMs: 2_400, panelLeadChanges: 4, deaths: 0 }));
assert.equal(plain[0], "Decided by 2.4 seconds");
assert.ok(plain.includes("Does the lead ever settle?"));
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
  console.log("OK: hookLabelProblem rejects a denied word and an invented vs-pair, never a real one");
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
assert.deepEqual(await hookSuggestions(input({ finishMarginMs: 2_400 })), ["Decided by 2.4 seconds"]);
console.log("OK: hookSuggestions filters a labelled chip too, not just suggestHooksExternally");
