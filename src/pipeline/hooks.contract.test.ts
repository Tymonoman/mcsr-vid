// Contract test for the title hooks (hooks.ts), written from the docs (CLAUDE.md "House rules" and
// "Hook chips", handbook/claude-md-reference.md "Hook chips", "Shorts", titleNames) by someone who
// had not read the code first. hooks.test.ts pins the chips against hand-made MatchMetrics; this
// file drives them end to end — real API match JSON (src/fixtures) through computeMetrics into
// buildHookSuggestions — and checks each chip against facts recomputed here from the raw timeline,
// so a chip is held to what the video shows, not to what the scorer says.
//
// The promises the docs make for titles and hooks (numbered the same in the sibling
// *.contract.test.ts files; the ones this file checks are marked *):
//  *P1  Nothing names the winner: no chip states the result or names the winner, and the facts
//       handed to an external generator carry no `winner`.
//  *P2  The upset/comeback hook is a question, never a flat claim ("Can a M:SS lead survive?").
//  *P3  A word on the short denied list (HOOK_DENIED_LABELS: a handful of ethnicity/nationality
//       terms, a slur-adjacent abbreviation; not exhaustive) is refused outright, "vs" or not, with
//       or without the match at hand.
//  *P4  A fresh "X vs Y" is checked against the match's own two players (API or titleNames
//       spelling); a mismatch is a label. "v", "v." and "versus" count as "vs"; so does a third side.
//       Each side is compared whole after trimming: punctuation or a lead-in on a side mismatches.
//   P5  A model's proposal (hookProblem) and a carried hookText (withHook) both fail closed on a
//       label the same way hookProblem does. (title/videoPick contract files)
//   P6  Only the operator's typed hook always saves; any problem is a warning in saveWarnings,
//       never a refusal. (shortFlow.saveHooks contract file)
//  *P7  No seed, rank or elo in hooks or suggestions — built-in or external generator. The
//       world's own seed type is not a bracket seed and stays fair game (P19).
//   P8  RETIRED 18 Oct 2026: the stake chips (margin, lead change, death) this promise ordered
//       are gone — a title is never about what happens in the race. P19 is the chip order now.
//   P9  RETIRED 18 Oct 2026: the swing ("lead held and lost") chip is gone with the other stake
//       chips.
//   P10 RETIRED 18 Oct 2026: the lead-change chip ("Does the lead ever settle?") is gone.
//   P11 RETIRED 18 Oct 2026: "Not a single death between them" is gone.
//   P12 RETIRED 18 Oct 2026: the DNF margin fallback ("One of them never killed the dragon") is
//       gone — a null margin states nothing any more.
//   P13 A joined series' chips read the game that decided it, not game 1's — pinned with a real
//       series record in src/playoffs/series.test.ts (hookFactsMatchId); not repeated here.
//  *P14 titleNames (default Pinne→Skycrab, lowk3y_→lowkey) is the title's spelling; a vs-pair in
//       that spelling is not a label.
//   P15 The long-form title is "<hook> | <left> vs <right> | …" with the <HOOK> placeholder until
//       a hook fills it; an over-budget hook is never truncated. (title contract file)
//   P16 The model's style examples (pastTitleHooks) show no "vs"-shaped hook at all, real
//       nicknames or not. (videoPick contract file)
//  *P17 Every suggestion, whatever produced it, passes the label check (hookSuggestions).
//   P18 RETIRED 18 Oct 2026: the forfeit/pace closeness claims it checked were stake chips.
//  *P19 18 Oct 2026: a chip is never about what happens in the race (no margin, lead, death or
//       pace) — only the setting, a forfeit, a real close finish (under a second, numbers
//       allowed) and a real head-to-head rivalry, close finish first.
//
// Where the code does not do what the docs say, the assertion stays as the docs say it and runs
// inside deviation(): it prints "DEVIATION: …" and the file still passes, until triage.
// Run: npx tsx src/pipeline/hooks.contract.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MatchInfo, UserDetails, VersusStats } from "../api/types.js";
import { seedPhrase } from "./description.js";
import {
  buildHookSuggestions,
  HOOK_SEED_RANK_ELO,
  hookFacts,
  hookLabelProblem,
  hookSuggestions,
  spoilsTheResult,
  suggestHooksExternally,
  titleEventProblem,
  type HookInput,
} from "./hooks.js";
import { computeMetrics } from "./matchScore.js";
import { buildTitle } from "./title.js";

delete process.env.HOOK_SUGGEST_CMD;

const deviations: string[] = [];
/** Runs a docs-exact check; an AssertionError is reported as a deviation instead of failing. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}
async function deviationAsync(clause: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const LABEL = "names a runner with a label: runners have objected to this (2 Oct 2026)";
const fixtures = path.join(import.meta.dirname, "..", "fixtures");
// The saved fixtures carry no `changes` (the API's per-match elo deltas); hookFacts reads them, so
// an empty list stands in — exactly what shortFlow.test.ts serves for the same files.
const load = (id: number | string): MatchInfo => {
  const m = JSON.parse(readFileSync(path.join(fixtures, `match-${id}.json`), "utf8")) as MatchInfo;
  return { ...m, changes: m.changes ?? [] };
};
const clone = (m: MatchInfo): MatchInfo => structuredClone(m);
const users = (m: MatchInfo) => m.players as unknown as [UserDetails, UserDetails];

/** The chips the dashboard would offer for a match, on its own title budget (as pipeline.ts asks). */
function chipsFor(match: MatchInfo, extra: Partial<HookInput> = {}, limit = 10): string[] {
  const [userLeft, userRight] = users(match);
  const budget = buildTitle({ leftNickname: userLeft.nickname, rightNickname: userRight.nickname });
  return buildHookSuggestions(
    {
      metrics: computeMetrics(match),
      match,
      userLeft,
      userRight,
      maxChars: Math.max(budget.hookMax, 40),
      minChars: budget.hookMin,
      ...extra,
    },
    limit,
  );
}

const ids = readdirSync(fixtures)
  .map((f) => /^match-(\d+)\.json$/.exec(f)?.[1])
  .filter((id): id is string => id !== undefined);
assert.ok(ids.length >= 10, "the real fixtures are the input this contract runs on");

/* --- Every real match: the house rules hold for every chip it gets ------------------------------ */
for (const id of ids) {
  const match = load(id);
  const chips = chipsFor(match);
  const nicknames = match.players.map((p) => p.nickname.toLowerCase());
  const marginMs = computeMetrics(match).finishMarginMs;
  for (const chip of chips) {
    // P1: nothing names the winner — no result word, and (with no head-to-head record asked for,
    // so no rematch chip) no player name at all, the winner's included.
    assert.ok(!spoilsTheResult(chip), `#${id}: "${chip}" gives the result away`);
    assert.ok(
      !nicknames.some((n) => chip.toLowerCase().includes(n)),
      `#${id}: "${chip}" names a player — a chip is about the match, never a person`,
    );
    // P7: no bracket seed, ladder rank or elo — the operator's call (24 Sept 2026), they change
    // daily. The world's own seed type ("village seed", a setting chip since 18 Oct 2026) is fair
    // game, by the same design `HOOK_SEED_RANK_ELO` already encodes — not re-checked by a blunter
    // bare-word regex here, which would also catch that chip.
    assert.ok(!HOOK_SEED_RANK_ELO.test(chip), `#${id}: "${chip}" uses a seed, rank or elo`);
    assert.ok(!/\belo\b|\brank(?:ed)?\b|#\d/i.test(chip), `#${id}: "${chip}" mentions elo/rank`);
    // P3/P4: a chip never labels a runner, judged against this match's own players.
    assert.equal(hookLabelProblem(chip, match.players), null, `#${id}: "${chip}" is a label`);
    // P19: never about what happens in the race — the one check every chip (built-in or external)
    // is held to since 18 Oct 2026.
    assert.equal(
      titleEventProblem(chip, { marginMs }),
      null,
      `#${id}: "${chip}" describes something happening in the race`,
    );
  }

  // P19: the setting chip exactly when the match carries a seed type, and it names that seed.
  const setting = seedPhrase(match);
  assert.equal(
    chips.includes(`A ${setting} race`),
    setting !== null,
    `#${id}: seed type ${JSON.stringify(setting)}, chips ${JSON.stringify(chips)}`,
  );

  // P19: the forfeit chip exactly on a forfeited match.
  assert.equal(chips.includes("It ended in a forfeit"), match.forfeited, `#${id}`);
}
console.log(`OK: every chip of ${ids.length} real matches is spoiler-, label- and event-free`);

/* --- P19: a real close finish (under a second) is the one place a chip still carries a number -- */
{
  for (const id of ids) {
    const match = load(id);
    const marginMs = computeMetrics(match).finishMarginMs;
    const chips = chipsFor(match);
    const close = chips.find((c) => c.startsWith("Decided by"));
    if (marginMs !== null && marginMs > 0 && marginMs < 1_000)
      assert.ok(close, `#${id}: a ${marginMs}ms finish gets no close-finish chip`);
    else assert.equal(close, undefined, `#${id}: a ${marginMs}ms margin is not "really close" (18 Oct 2026)`);
  }
}
console.log("OK: the close-finish chip fires only under a second, by the real margin");

/* --- P19: the new chip order — close finish, then forfeit, then rivalry, then the setting ----- */
{
  const m = load(13549300); // a 0.3s finish
  const [l, r] = users(m);
  const won = (uuid: string) => (m.result.uuid === uuid ? 1 : 0);
  const versus = {
    results: { ranked: { [l.uuid]: 2 + won(l.uuid), [r.uuid]: 1 + won(r.uuid) } },
  } as unknown as VersusStats;
  const chips = chipsFor(m, { versus, maxChars: 47 });
  const rematch = chips.findIndex((c) => c.startsWith("Rematch"));
  assert.ok(rematch > 0, `a rematch chip, not first: ${JSON.stringify(chips)}`);
  assert.equal(chips[0], "Decided by 0.3 seconds", "a photo finish leads the rivalry");
}
console.log("OK: a close finish leads, the rivalry follows");

/* --- P19: the forfeit chip states a forfeit plainly, nothing else about the race -------------- */
{
  const ff = clone(load(13448958));
  ff.forfeited = true;
  const chips = chipsFor(ff);
  assert.ok(chips.includes("It ended in a forfeit"), JSON.stringify(chips));
}
console.log("OK: a forfeit is stated plainly");
/* --- P1: the external generator is never handed the winner --------------------------------- */
{
  const m = load(13549300);
  const [userLeft, userRight] = users(m);
  const facts = hookFacts({
    metrics: computeMetrics(m),
    match: m,
    userLeft,
    userRight,
    maxChars: 40,
    minChars: 0,
  });
  assert.ok(!("winner" in facts), "the facts carry no winner field");
  assert.ok(!JSON.stringify(facts).includes(m.result.uuid!), "nor the winner's uuid anywhere");
}

/* --- P3: a denied word, "vs" or not, with or without the match ----------------------------- */
{
  const players = [{ nickname: "alpha_run" }, { nickname: "beta_run" }];
  // Each listed term on its own, in a sentence, any case, with and without players.
  for (const hook of [
    "THE KOREAN GRINDER",
    "a mexican speedrunner?",
    "Chinese strats only",
    "THE JAPANESE vs alpha_run",
  ]) {
    assert.equal(hookLabelProblem(hook), LABEL, `no match: ${hook}`);
    assert.equal(hookLabelProblem(hook, players), LABEL, `with the match: ${hook}`);
  }
  // Word boundaries: Minecraft's own blackstone and a whiteout are not race words.
  for (const fine of ["BLACKSTONE BRIDGE", "A WHITEOUT IN THE END", "Decided by 2.4 seconds"])
    assert.equal(hookLabelProblem(fine, players), null, fine);

  // Plurals of the listed terms are the same terms ("asians"/"arabs" are already in the list).
  deviation('P3 "a denied word (an ethnicity/nationality term) is refused outright" — plural forms', () => {
    const missed = [
      "TWO KOREANS, ONE DRAGON",
      "THE MEXICANS ARE HERE",
      "AMERICANS AT THE PORTAL",
      "EUROPEANS ONLY",
    ].filter((h) => hookLabelProblem(h) === null);
    assert.deepEqual(missed, [], `plural denied terms pass: ${JSON.stringify(missed)}`);
  });
  // The list is short on purpose ("deliberately not exhaustive"): a nationality term not on it
  // passes unless it sits in a vs-pair. Adding one to HOOK_DENIED_LABELS moves it up to the loop above.
  for (const offList of ["THE GERMAN GRINDER", "BRAZILIAN BLITZ", "THE RUSSIAN RUNNER", "CANADIAN CLASH"])
    assert.equal(hookLabelProblem(offList, players), null, `off the list: ${offList}`);
  assert.equal(hookLabelProblem("alpha_run vs THE GERMAN", players), LABEL, "vs-shaped, it is a label");
}
console.log("OK: denied words are refused with or without the match");

/* --- P4/P14: an "X vs Y" pair against a real match's own players ----------------------------- */
{
  const m = load(13782182);
  const [l, r] = m.players.map((p) => p.nickname);
  // The real pair, every "vs" spelling, either order, any case: not a label.
  for (const hook of [
    `${l} vs ${r}`,
    `${r!.toUpperCase()} VS ${l!.toUpperCase()}`,
    `${l} v. ${r}`,
    `${l} versus ${r}`,
    `${l} v ${r}`,
  ])
    assert.equal(hookLabelProblem(hook, m.players), null, hook);
  // An invented side, a third side, an abstract side: all labels. Probed on an invented pair, so
  // no epithet sits beside a real runner's name in test data.
  const invented = [{ nickname: "alpha_run" }, { nickname: "beta_run" }];
  for (const hook of [
    "alpha_run vs THE GRINDER",
    "SPEEDY v. SLOWPOKE",
    "alpha_run vs beta_run vs THE CLOCK",
    "SPEED VERSUS SAFETY",
  ])
    assert.equal(hookLabelProblem(hook, invented), LABEL, hook);
  // "1v1" is the format, not a pair.
  assert.equal(hookLabelProblem("THEIR FIRST 1v1", m.players), null);

  // Each side is compared whole after trimming, so punctuation or a lead-in on a side is a
  // mismatch, even around the real pair: a model's proposal is dropped, a typed hook warns.
  for (const hook of [`${l} vs ${r}?`, `${l} VS ${r}!`, `REMATCH: ${l} vs ${r}`])
    assert.equal(hookLabelProblem(hook, m.players), LABEL, hook);

  // titleNames: Pinne and lowk3y_ by API spelling, broadcast spelling, or one of each.
  const broadcast = [{ nickname: "Pinne" }, { nickname: "lowk3y_" }];
  for (const hook of ["Skycrab vs lowkey", "Pinne vs lowk3y_", "SKYCRAB VS LOWK3Y_", "lowkey versus Pinne"])
    assert.equal(hookLabelProblem(hook, broadcast), null, hook);
  // The broadcast names are only real for a match that has those players.
  assert.equal(hookLabelProblem("Skycrab vs lowkey", m.players), LABEL);
}
console.log("OK: a vs-pair is judged against the match's own players, either spelling");

/* --- P7/P17: the external generator's output is held to the house rules -------------------- */
{
  const m = load(13549300);
  const [userLeft, userRight] = users(m);
  const input: HookInput = {
    metrics: computeMetrics(m),
    match: m,
    userLeft,
    userRight,
    maxChars: 40,
    minChars: 0,
  };
  const sh = (lines: string[]) => `printf '${lines.join("\\n")}\\n'`;

  // A label, a result and an invented pair never come back, whatever the command printed (P1/P4).
  process.env.HOOK_SUGGEST_CMD = sh([
    "Decided at the dragon",
    "SPEEDY versus SLOWPOKE",
    "alpha_run WINS IT",
    "THE KOREAN GRINDER",
  ]);
  assert.deepEqual(await suggestHooksExternally(input), ["Decided at the dragon"]);
  assert.deepEqual(await hookSuggestions(input), ["Decided at the dragon"]);

  // P7: elo and rank in the shapes a generator writes them — a single figure next to the word.
  await deviationAsync(
    'P7 "No seed, rank or elo in hooks or suggestions" — a single elo/rank figure',
    async () => {
      process.env.HOOK_SUGGEST_CMD = sh([
        "Decided at the dragon",
        "A 2400 ELO SHOWDOWN",
        "RANK 1 IN THE BUILDING",
        "THE NO. 1 SEED RETURNS",
      ]);
      const got = await hookSuggestions(input);
      assert.deepEqual(
        got,
        ["Decided at the dragon"],
        `elo/rank/seed suggestions pass: ${JSON.stringify(got)}`,
      );
    },
  );
  delete process.env.HOOK_SUGGEST_CMD;
}
console.log("OK: the external generator is filtered for labels, results and elo");

if (deviations.length)
  console.log(`hooks.contract: ${deviations.length} deviation(s) from the docs, listed above`);
console.log("hooks.contract: all checks passed");
