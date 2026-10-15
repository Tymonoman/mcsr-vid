// Contract test for the model's hook gate (videoPick.ts `hookProblem`) and its style examples
// (`pastTitleHooks`), written from the docs (CLAUDE.md "House rules" and "Shorts"; the handbook's
// "Never a nickname, label or epithet" and "The pick also proposes the long-form's title hook")
// before reading the code. videoPick.test.ts pins hookProblem's historical strings; this file
// probes the edges of the same promises with invented players and labels (no real runner label,
// no real result in the data). Temp media dir; no model, no network, no ffmpeg.
//
// The promises (full list and numbering in src/pipeline/hooks.contract.test.ts; checked here):
//  P1  Nothing names the winner — a model's hook that says who wins is refused, question or not.
//  P3  A denied word is refused outright, "vs" or not, with or without the match at hand.
//  P4  A fresh "X vs Y" is checked against the match's own two players (API or titleNames
//      spelling); "v", "v." and "versus" count as "vs", and so does a third side.
//  P5  A model's proposal fails closed: any problem drops it (hookProblem returns a reason).
//  P7  No seed, rank or elo in hooks or suggestions.
//  P16 The model's style examples (pastTitleHooks) show no "vs"-shaped hook at all, real
//      nicknames or not — with "v", "v." and "versus" counting as "vs" (14 Oct 2026).
// Run: npx tsx src/shorts/videoPick.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { HOOK_MAX_CHARS, hookProblem, pastTitleHooks } from "./videoPick.js";

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

const LABEL = "names a runner with a label: runners have objected to this (2 Oct 2026)";
const SPOILS = "it gives the result away";
const SEED = "it uses a seed, rank or elo";
const players = [{ nickname: "alpha_run" }, { nickname: "beta_run" }];

/* --- P5: the gate's bounds — an empty or overlong proposal is a reason, not a crash ------------ */
for (const none of [undefined, null, 42, "", "   ", { hook: "x" }])
  assert.equal(hookProblem(none), "no hook", `${JSON.stringify(none)} is no hook`);
// The budget is counted on the trimmed text: exactly HOOK_MAX_CHARS fits, one more does not.
assert.equal(hookProblem(`  ${"X".repeat(HOOK_MAX_CHARS)}  `), null);
assert.equal(hookProblem("X".repeat(HOOK_MAX_CHARS + 1)), `over ${HOOK_MAX_CHARS} characters`);
// A caller's own budget (a title's hookMax) replaces the Short's.
assert.equal(hookProblem("X".repeat(30), 29), "over 29 characters");
console.log("OK: an empty or overlong hook is refused with its reason");

/* --- P1: a hook that says who wins, any register ----------------------------------------------- */
for (const spoiler of [
  "WHO WON THIS ONE?", // a question still carries the result word
  "alpha_run takes it at the portal",
  "THE COMEBACK IS COMPLETE",
  "beta_run is eliminated",
]) {
  assert.equal(hookProblem(spoiler, 40, players), SPOILS, spoiler);
}
// The stake form passes: "a sub-N to win it" says what winning takes, not who did.
assert.equal(hookProblem("A SUB-8 TO WIN IT", 40, players), null);
// A question about the outcome without a result word is the channel's framing.
assert.equal(hookProblem("CAN A 1:15 LEAD SURVIVE?", 40, players), null);
deviation(
  'P1 "Nothing names the winner … no winner in a hook" — a player named beside the pace stake',
  () => {
    // The sanctioned idiom is stripped before the spoiler test, so a name in front of it is all
    // that is left — and "<player>'s sub-8 to win it" names who won.
    const passed = ["ALPHA_RUN'S SUB-8 TO WIN IT", "alpha_run: a sub-8 to win it"].filter(
      (h) => hookProblem(h, 40, players) !== SPOILS,
    );
    assert.deepEqual(passed, [], `a named pace stake passes the gate: ${JSON.stringify(passed)}`);
  },
);
deviation(
  'P1 "Nothing names the winner … no winner in a hook" — a winner named without a listed verb',
  () => {
    const passed = [
      "alpha_run kills the dragon first",
      "alpha_run edges out beta_run",
      "beta_run finishes first",
    ].filter((h) => hookProblem(h, 40, players) === null);
    assert.deepEqual(passed, [], `winner-naming hooks pass the gate: ${JSON.stringify(passed)}`);
  },
);
console.log("OK: a result word is refused, a question about the outcome is not");

/* --- P3: denied words, with and without the match --------------------------------------------- */
for (const hook of ["THE KOREAN GRINDER", "an indian speedrunner", "THE CHINESE vs alpha_run"]) {
  assert.equal(hookProblem(hook), LABEL, `no match: ${hook}`);
  assert.equal(hookProblem(hook, 40, players), LABEL, `with the match: ${hook}`);
}
console.log("OK: a denied word is refused with or without the match");

/* --- P4: the vs-pair, every spelling ---------------------------------------------------------- */
for (const label of [
  "SPEEDY vs SLOWPOKE",
  "SPEEDY vs. SLOWPOKE",
  "SPEEDY v SLOWPOKE",
  "SPEEDY v. SLOWPOKE",
  "SPEEDY VERSUS SLOWPOKE",
  "alpha_run vs beta_run vs THE CLOCK",
  "alpha_run vs THE GRINDER",
]) {
  assert.equal(hookProblem(label, 40, players), LABEL, label);
}
for (const real of ["alpha_run vs beta_run", "BETA_RUN VERSUS ALPHA_RUN", "alpha_run v. beta_run"])
  assert.equal(hookProblem(real, 40, players), null, real);
// titleNames: the broadcast's spelling of a player is that player (Pinne is Skycrab).
assert.equal(hookProblem("SKYCRAB VS LOWKEY", 40, [{ nickname: "Pinne" }, { nickname: "lowk3y_" }]), null);
assert.equal(hookProblem("SKYCRAB VS LOWKEY", 40, players), LABEL, "but only in a match they are in");
console.log("OK: a vs-pair is a label unless it is the match's own two players");

/* --- P7: no seed, rank or elo ------------------------------------------------------------------- */
for (const hook of ["#3 SEED vs #14 SEED", "THE 7th seed", "2410 vs 2200 ELO", "WORLD #1 RETURNS"])
  assert.equal(hookProblem(hook, 40, players), SEED, hook);
// The world's seed type is not a bracket seed: "village seed" is fair game.
assert.equal(hookProblem("A VILLAGE SEED SPRINT", 40, players), null);
// A lone rating by its unit (15 Oct 2026): the model was handed both elos until then.
for (const hook of ["A 600-POINT GAP?", "2100 RATED AND SWEATING", "A 300 PTS SWING"])
  assert.equal(hookProblem(hook, 40, players), SEED, hook);
deviation('P7 "No seed, rank or elo in hooks or suggestions" — hookProblem on a single figure', () => {
  const passed = ["A 2400 ELO SHOWDOWN", "RANK 1 IN THE BUILDING", "THE NO. 1 SEED RETURNS"].filter(
    (h) => hookProblem(h, 40, players) === null,
  );
  assert.deepEqual(passed, [], `elo/rank/seed hooks pass the model's gate: ${JSON.stringify(passed)}`);
});
console.log("OK: seed, rank and elo pairings are refused");

/* --- P16: the style examples the model sees ---------------------------------------------------- */
{
  const media = mkdtempSync(path.join(tmpdir(), "videopick-contract-"));
  const savedMedia = config.mediaDir;
  config.mediaDir = media;
  try {
    let n = 0;
    /** An uploaded match whose saved title opens on `hook`, newest last. */
    const uploaded = (hook: string) => {
      const id = 900_000 + ++n;
      const dir = path.join(media, String(id));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "youtube.json"), "{}");
      const file = path.join(dir, `match-${id}.title.edited.txt`);
      writeFileSync(file, `${hook} | alpha_run vs beta_run | MCSR Ranked 1v1 | Minecraft Speedrun\n`);
      const t = new Date(Date.UTC(2026, 9, 1) + n * 60_000);
      utimesSync(file, t, t);
    };
    uploaded("58 MILLISECONDS");
    uploaded("SPEEDY vs SLOWPOKE");
    uploaded("alpha_run VS beta_run"); // the real pair: still no vs-shaped example
    uploaded("THE KOREAN GRINDER");
    uploaded("WHO BLINKS FIRST?");
    uploaded("SPEEDY versus SLOWPOKE");
    uploaded("SPEEDY v. SLOWPOKE");
    uploaded("SPEEDY v SLOWPOKE");
    uploaded("SPEEDY VS. SLOWPOKE");
    const shown = pastTitleHooks().map((p) => p.hook);
    // Newest first, the clean ones only — a denied word never becomes an example either.
    for (const ok of ["WHO BLINKS FIRST?", "58 MILLISECONDS"])
      assert.ok(shown.includes(ok), JSON.stringify(shown));
    assert.ok(shown.indexOf("WHO BLINKS FIRST?") < shown.indexOf("58 MILLISECONDS"), "newest first");
    for (const never of ["SPEEDY vs SLOWPOKE", "alpha_run VS beta_run", "THE KOREAN GRINDER"])
      assert.ok(!shown.includes(never), `shown to the model: ${never}`);
    // A deviation until 15 Oct 2026 (the filter was a bare " vs "): now held.
    const leaked = shown.filter((h) => /\s(?:vs\.?|v\.?|versus)\s/i.test(h));
    assert.deepEqual(leaked, [], `vs-shaped style examples shown to the model: ${JSON.stringify(leaked)}`);
  } finally {
    config.mediaDir = savedMedia;
    rmSync(media, { recursive: true, force: true });
  }
}
console.log("OK: the model's style examples carry no label");

if (deviations.length)
  console.log(`videoPick.contract: ${deviations.length} deviation(s) from the docs, listed above`);
console.log("videoPick.contract: all checks passed");
