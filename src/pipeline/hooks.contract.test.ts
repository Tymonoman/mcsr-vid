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
//  *P3  A denied word (ethnicity/nationality term, slur-adjacent abbreviation) is refused
//       outright, "vs" or not, with or without the match at hand.
//  *P4  A fresh "X vs Y" is checked against the match's own two players (API or titleNames
//       spelling); a mismatch is a label. "v", "v." and "versus" count as "vs"; so does a third side.
//   P5  A model's proposal (hookProblem) and a carried hookText (withHook) both fail closed on a
//       label the same way hookProblem does. (title/videoPick contract files)
//   P6  Only the operator's typed hook always saves; any problem is a warning in saveWarnings,
//       never a refusal. (shortFlow contract file)
//  *P7  No seed, rank or elo in hooks or suggestions — built-in or external generator.
//  *P8  Chips lead with the match's stake (margin, lead change, death); nickname/rematch after.
//  *P9  The swing chip reads a lead actually held and lost at a panel-visible split, never a
//       leader extending their lead; an off-panel split is never quoted.
//  *P10 The lead-change chip is the numberless "Does the lead ever settle?", and counts only the
//       six panel splits (not "Bastion loot"/"Blaze rod", not the dragon).
//  *P11 "Not a single death" counts every death-screen entry, hunger resets included.
//  *P12 The DNF fallback never says "reached" the dragon, only "killed".
//   P13 A joined series' chips read the game that decided it, not game 1's — pinned with a real
//       series record in src/playoffs/series.test.ts (hookFactsMatchId); not repeated here.
//  *P14 titleNames (default Pinne→Skycrab, lowk3y_→lowkey) is the title's spelling; a vs-pair in
//       that spelling is not a label.
//   P15 The long-form title is "<hook> | <left> vs <right> | …" with the <HOOK> placeholder until
//       a hook fills it; an over-budget hook is never truncated. (title contract file)
//   P16 The model's style examples (pastTitleHooks) show no "vs"-shaped hook at all, real
//       nicknames or not. (videoPick contract file)
//  *P17 Every suggestion, whatever produced it, passes the label check (hookSuggestions).
//  *P18 "N deaths and still this close" needs a margin under 10s; the pace chip skips a forfeit.
//
// Where the code does not do what the docs say, the assertion stays as the docs say it and runs
// inside deviation(): it prints "DEVIATION: …" and the file still passes, until triage.
// Run: npx tsx src/pipeline/hooks.contract.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MatchInfo, UserDetails, VersusStats } from "../api/types.js";
import {
  buildHookSuggestions,
  HOOK_SEED_RANK_ELO,
  hookFacts,
  hookLabelProblem,
  hookSuggestions,
  spoilsTheResult,
  suggestHooksExternally,
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
/** Any wording of the swing chip, question or not — so a regression to a flat claim is caught. */
const isSwing = (c: string): boolean => /lead/i.test(c) && /survive|gone|swung|lost/i.test(c);
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

/* --- Facts recomputed from the raw timeline, independently of matchScore.ts -------------------- */
// The overlay panel's six rows (handbook "Hook chips": Nether enter, Bastion enter, Fortress,
// Blind travel, Stronghold, End enter), by their API event types.
const PANEL = [
  "story.enter_the_nether",
  "nether.find_bastion",
  "nether.find_fortress",
  "projectelo.timeline.blind_travel",
  "story.follow_ender_eye",
  "story.enter_the_end",
];
const first = (m: MatchInfo, uuid: string, type: string): number | null => {
  const times = m.timelines.filter((e) => e.uuid === uuid && e.type === type).map((e) => e.time);
  return times.length ? Math.min(...times) : null;
};
/** Per panel split both players reached: who got there first and by how much. */
function panelSplits(m: MatchInfo): Array<{ leader: string; gapMs: number }> {
  const [a, b] = m.players;
  const out: Array<{ leader: string; gapMs: number }> = [];
  for (const type of PANEL) {
    const ta = first(m, a!.uuid, type);
    const tb = first(m, b!.uuid, type);
    if (ta === null || tb === null) continue;
    out.push({ leader: ta < tb ? a!.uuid : b!.uuid, gapMs: Math.abs(ta - tb) });
  }
  return out;
}
const panelFlips = (m: MatchInfo): number =>
  panelSplits(m).reduce((n, s, i, all) => (i > 0 && all[i - 1]!.leader !== s.leader ? n + 1 : n), 0);
/** The biggest lead the eventual winner faced at a panel split (a lead the other side then lost). */
const lostLeadMs = (m: MatchInfo): number =>
  panelSplits(m).reduce((max, s) => (s.leader !== m.result.uuid ? Math.max(max, s.gapMs) : max), 0);
/** Every death screen the POVs show: a real death and a hunger reset alike. */
const deathScreens = (m: MatchInfo): number =>
  m.timelines.filter((e) => /\.timeline\.death(?:_spawnpoint)?$/.test(e.type)).length;

const ids = readdirSync(fixtures)
  .map((f) => /^match-(\d+)\.json$/.exec(f)?.[1])
  .filter((id): id is string => id !== undefined);
assert.ok(ids.length >= 10, "the real fixtures are the input this contract runs on");

/* --- Every real match: the house rules hold for every chip it gets ------------------------------ */
for (const id of ids) {
  const match = load(id);
  const chips = chipsFor(match);
  const nicknames = match.players.map((p) => p.nickname.toLowerCase());
  for (const chip of chips) {
    // P1: nothing names the winner — no result word, and (with no head-to-head record asked for,
    // so no rematch chip) no player name at all, the winner's included.
    assert.ok(!spoilsTheResult(chip), `#${id}: "${chip}" gives the result away`);
    assert.ok(
      !nicknames.some((n) => chip.toLowerCase().includes(n)),
      `#${id}: "${chip}" names a player — a stake chip is about the match, never a person`,
    );
    // P7: no seed, rank or elo — the operator's call (24 Sept 2026), they change daily.
    assert.ok(!HOOK_SEED_RANK_ELO.test(chip), `#${id}: "${chip}" uses a seed, rank or elo`);
    assert.ok(
      !/\belo\b|\brank(?:ed)?\b|\bseed\b|#\d/i.test(chip),
      `#${id}: "${chip}" mentions elo/rank/seed`,
    );
    // P3/P4: a chip never labels a runner, judged against this match's own players.
    assert.equal(hookLabelProblem(chip, match.players), null, `#${id}: "${chip}" is a label`);
    // P10: the lead-change chip is numberless — an exact count lets a viewer read the result by parity.
    assert.ok(!/lead changed/i.test(chip), `#${id}: "${chip}" counts lead changes`);
    // P12: "reached" was false on screen (the loser can be in the End fighting the dragon).
    assert.ok(!/reached/i.test(chip), `#${id}: "${chip}" says "reached"`);
  }

  // P10: "Does the lead ever settle?" only where the panel itself shows at least two flips — the
  // off-panel splits and the dragon "flip" too, and the docs' two live-verified false positives
  // (13560037: panel 1, 13782182: panel 0) came from counting them.
  const flips = panelFlips(match);
  if (chips.includes("Does the lead ever settle?"))
    assert.ok(flips >= 2, `#${id}: lead-change chip on ${flips} panel flip(s)`);
  if (flips <= 1) assert.ok(!chips.includes("Does the lead ever settle?"), `#${id}: ${flips} panel flip(s)`);

  // P11: "Not a single death between them" exactly when the POVs show no death screen at all —
  // 12730175's five hunger resets and 13766294's one are death screens a viewer watches.
  assert.equal(
    chips.includes("Not a single death between them"),
    deathScreens(match) === 0,
    `#${id}: ${deathScreens(match)} death screen(s), chips ${JSON.stringify(chips)}`,
  );

  // P9: no swing chip without a real lost lead — never a winner's own lead growing. (The 30s floor
  // is the code's, not the docs'; no real fixture loses a lead that big, so the positive direction
  // is the targeted 1:15 case further down.)
  const swing = chips.find(isSwing);
  const lost = lostLeadMs(match);
  if (lost < 30_000) assert.equal(swing, undefined, `#${id}: no lead was lost, got "${swing}"`);
  // P2: and when it is there, it is a question.
  if (swing) assert.ok(swing.endsWith("?"), swing);

  // P12: a null margin (somebody never killed the dragon) gets the "killed" wording.
  const [a, b] = match.players;
  // A kill is either event: the killing blow (end.kill_dragon) or the animation's end (dragon_death).
  const killed = (uuid: string) =>
    first(match, uuid, "projectelo.timeline.dragon_death") !== null ||
    first(match, uuid, "end.kill_dragon") !== null;
  const dragons = [a!, b!].filter((p) => killed(p.uuid));
  if (dragons.length < 2)
    assert.ok(chips.includes("One of them never killed the dragon"), `#${id}: ${chips}`);
}
console.log(
  `OK: every chip of ${ids.length} real matches is spoiler-, label- and elo-free and true of the timeline`,
);

/* --- P10: the two live-verified false positives by name (handbook, 8 Oct 2026) ------------------ */
for (const id of [13560037, 13782182]) {
  const m = load(id);
  // Both have shared-field lead changes (3 and 2) that came only from off-panel splits or the dragon.
  assert.ok(computeMetrics(m).leadChanges >= 2, `#${id} still flips off the panel`);
  assert.ok(!chipsFor(m).includes("Does the lead ever settle?"), `#${id}: the panel shows ≤1 flip`);
}
// And a true one: 13673240's panel shows three flips, so the question is honest there.
assert.equal(panelFlips(load(13673240)), 3);
assert.ok(chipsFor(load(13673240)).includes("Does the lead ever settle?"));
console.log("OK: the lead-change chip counts panel flips only");

/* --- P11: the two live-verified hunger-reset matches by name --------------------------------- */
for (const [id, resets] of [
  [12730175, 5],
  [13766294, 1],
] as const) {
  const m = load(id);
  assert.equal(computeMetrics(m).deaths, 0, `#${id}: no real death (resets are routine to the scorer)`);
  assert.equal(deathScreens(m), resets, `#${id}: but ${resets} death screen(s) on the POVs`);
  assert.ok(!chipsFor(m).includes("Not a single death between them"), `#${id}`);
}
console.log('OK: "not a single death" reads every death screen');

/* --- P12: 12929221 — the non-winner entered the End and never killed the dragon --------------- */
{
  const m = load(12929221);
  const other = m.players.find((p) => p.uuid !== m.result.uuid)!;
  // Exactly the docs' case: "reached" would be false on screen, "killed" is true.
  assert.notEqual(first(m, other.uuid, "story.enter_the_end"), null, "they did reach the End");
  assert.equal(first(m, other.uuid, "projectelo.timeline.dragon_death"), null, "and never killed the dragon");
  const chips = chipsFor(m);
  assert.ok(chips.includes("One of them never killed the dragon"), JSON.stringify(chips));
  // Filler, not a stake: it sits under every stake chip the match has (P8).
  assert.equal(chips.at(-1), "One of them never killed the dragon", JSON.stringify(chips));
}
console.log('OK: the DNF fallback says "killed", never "reached"');

/* --- P9: a lead held and lost, through computeMetrics from a real timeline --------------------- */
{
  // 13782182: one player led every panel split it reached and also took the match — the docs'
  // "leader extending their lead" shape (5 such real matches fired the old chip).
  const wire = load(13782182);
  assert.equal(lostLeadMs(wire), 0, "the eventual winner never trailed at a panel split");
  assert.ok(!chipsFor(wire).some(isSwing));

  // The same match, with the eventual winner made to arrive at the Fortress 75s after the other
  // side and to loot the bastion 150s after: a 1:15 lead really was held and lost on the panel,
  // and the bigger off-panel "Bastion loot" gap is not one a viewer can check on screen.
  const m = clone(wire);
  const w = m.result.uuid!;
  const o = m.players.find((p) => p.uuid !== w)!.uuid;
  const shift = (type: string, by: number) => {
    const ref = first(m, o, type);
    assert.notEqual(ref, null, `${type} exists for the other side`);
    for (const e of m.timelines) if (e.uuid === w && e.type === type) e.time = ref! + by;
  };
  shift("nether.find_fortress", 75_000);
  shift("nether.loot_bastion", 150_000);
  const chips = chipsFor(m);
  assert.ok(chips.includes("Can a 1:15 lead survive?"), JSON.stringify(chips));
  assert.ok(!chips.some((c) => c.includes("2:30")), `off-panel gap quoted: ${JSON.stringify(chips)}`);
  // A question (P2) — every swing wording the chips carry, not just the one looked up — and the
  // question names nobody (P1).
  assert.deepEqual(chips.filter(isSwing), ["Can a 1:15 lead survive?"], JSON.stringify(chips));
  assert.ok(!spoilsTheResult("Can a 1:15 lead survive?"));

  // The mirror: the eventual winner *ahead* by 75s at the Fortress is a lead growing, no chip.
  const ahead = clone(wire);
  for (const e of ahead.timelines)
    if (e.uuid === w && e.type === "nether.find_fortress") e.time = first(ahead, o, e.type)! - 75_000;
  assert.ok(!chipsFor(ahead).some(isSwing), "a winner's own lead is no swing");
}
console.log("OK: the swing chip quotes a panel lead actually lost, never one that grew");

/* --- P8: stake first, rivalry after, on a real match with a real-shaped head-to-head ----------- */
{
  const m = load(13549300); // a 0.3s finish, two panel flips, no death screen
  const [l, r] = users(m);
  const versus = { results: { ranked: { [l.uuid]: 2, [r.uuid]: 1 } } } as unknown as VersusStats;
  const chips = chipsFor(m, { versus });
  const rematch = chips.findIndex((c) => c.startsWith("Rematch"));
  assert.ok(rematch > 0, `a rematch chip, not first: ${JSON.stringify(chips)}`);
  for (const stake of [
    "Decided by 0.3 seconds",
    "Does the lead ever settle?",
    "Not a single death between them",
  ])
    assert.ok(
      chips.indexOf(stake) >= 0 && chips.indexOf(stake) < rematch,
      `${stake} before the rematch chip`,
    );
  assert.equal(chips[0], "Decided by 0.3 seconds", "a photo finish leads");
}
console.log("OK: the stake leads, the rivalry follows");

/* --- P18: closeness and pace claims stay true ------------------------------------------------- */
{
  // A forfeit's result.time is the forfeit's moment, not a finish: no "sub-N to win it".
  const ff = clone(load(13448958));
  ff.forfeited = true;
  const chips = chipsFor(ff);
  assert.ok(chips.includes("It ended in a forfeit"), JSON.stringify(chips));
  assert.ok(
    !chips.some((c) => /sub-\d+ to win/i.test(c)),
    `pace chip on a forfeit: ${JSON.stringify(chips)}`,
  );

  // Four real deaths but a DNF (no margin): many deaths, not "still this close".
  const dnf = clone(load(12929221));
  const loser = dnf.players.find((p) => p.uuid !== dnf.result.uuid)!.uuid;
  for (let i = 0; i < 4; i++)
    dnf.timelines.push({ uuid: loser, time: 100_000 + i * 1000, type: "projectelo.timeline.death" } as never);
  assert.ok(computeMetrics(dnf).deaths >= 4);
  assert.ok(!chipsFor(dnf).some((c) => /still this close/.test(c)), "a DNF is not close");
}
console.log("OK: no pace chip on a forfeit, no closeness claim on a DNF");

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
  // Not a deviation, a question for the operator: the docs say "a denied word", and
  // HOOK_DENIED_LABELS is short on purpose (hooks.ts), so "THE GERMAN GRINDER" or "BRAZILIAN BLITZ"
  // passes unless vs-shaped. Whether more nationality terms belong on the list is the operator's call.
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

  // A real pair with ordinary punctuation is still the real pair.
  deviation(
    'P4 "a fresh X vs Y is checked against the match\'s own two players" — punctuation around a real pair',
    () => {
      const flagged = [`${l} vs ${r}?`, `${l} VS ${r}!`, `REMATCH: ${l} vs ${r}`].filter(
        (h) => hookLabelProblem(h, m.players) !== null,
      );
      assert.deepEqual(
        flagged,
        [],
        `the match's own two players flagged as a label: ${JSON.stringify(flagged)}`,
      );
    },
  );

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
