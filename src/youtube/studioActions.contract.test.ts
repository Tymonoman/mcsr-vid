// Contract test for the two pure helpers the Studio worker leans on (src/youtube/studioActions.ts):
// `titleTestProblem` (every Test & Compare title is checked before any page opens) and
// `parseTcReport` (when a test is done, and who Studio says won). Written from the docs only, as
// an outside engineer would; the browser-driving half (studioActions.test.ts) is not touched.
// No browser, no network, no disk. Run: npx tsx src/youtube/studioActions.contract.test.ts
//
// What the docs promise (CLAUDE.md "Studio automation", "House rules"; handbook
// claude-md-reference.md "Phase 2/3" and "Phase 4"):
//  T1. Every TC title is checked against a 100-character ceiling (TITLE_MAX_CHARS): 100 passes,
//      101 is refused.
//  T2. `spoilsTheResult` runs against the WHOLE line — a result word does not have to sit in the
//      hook segment to spoil it.
//  T3. `hookProblem` runs on the hook — so no seed, rank or elo in a TC title's hook.
//  T4. `hookLabelProblem` runs on the hook — an invented "X vs Y" is a label; the match's own two
//      players, API or `titleNames` spelling, are not.
//  T5. A label check with no players at hand fails closed (any "X vs Y" is refused).
//  T6. What the channel actually ran live (the Grand Finals title test, the documented
//      "Does the lead ever settle?" chip, an upset question) is never refused.
//  T7. "Never a runner nickname, label or epithet, 'vs' or not … a fresh 'X vs Y' is checked
//      against the match's own two players … a mismatch is a label too" — including the title's
//      own pair slot, which a challenger title can rewrite.
//  R1. Studio's "Results ready" / "Test finished" mean done; the live "Test running… · Estimated
//      time remaining" does not; nothing read is not done.
//  R2. The winner comes only from Studio's own "Winner" mark: lopsided shares with no mark give no
//      winner (the worker never sets one itself).
//  R3. A winner in slot 2 (the challenger), marked consistently, is read as slot 2 with the shares
//      in slot order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { buildTitle, HOOK_PLACEHOLDER } from "../pipeline/title.js";
import { parseTcReport, titleTestProblem } from "./studioActions.js";

/** Keeps a documented promise the code does not meet visible without failing the suite. */
const deviations: string[] = [];
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
    deviations.push(clause);
  }
}

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

// A real ranked match's players, and the title the pipeline itself would build for it.
const ranked = fixture(12730175);
const players = ranked.players.map((p) => ({ nickname: p.nickname }));
const rankedTitle = (hook: string): string =>
  buildTitle({ leftNickname: players[0]!.nickname, rightNickname: players[1]!.nickname }).title.replace(
    HOOK_PLACEHOLDER,
    hook,
  );
// The Grand Finals pair (lowk3y_ is titled "lowkey" by config.titleNames) with its playoff suffix.
const gfPlayers = [{ nickname: "lowk3y_" }, { nickname: "Infume" }];
const gfTitle = (hook: string): string =>
  buildTitle({
    leftNickname: "lowk3y_",
    rightNickname: "Infume",
    suffix: "MCSR Ranked Season 11 Playoffs | Grand Finals",
  }).title.replace(HOOK_PLACEHOLDER, hook);

// --- T1: the 100-character ceiling, at the boundary ---------------------------------------------
{
  const at100 = gfTitle("IT ALL COMES DOWN TO THE VERY END");
  const at101 = gfTitle("IT ALL COMES DOWN TO THE VERY END!");
  assert.equal(at100.length, 100, "precondition: the boundary title is exactly 100 characters");
  assert.equal(at101.length, 101, "precondition: one more character is 101");
  // YouTube's own title limit is 100: a title at it can start, one over it can never be applied.
  assert.equal(titleTestProblem(at100, gfPlayers), null, "exactly 100 characters is inside the ceiling");
  assert.match(
    String(titleTestProblem(at101, gfPlayers)),
    /over 100 characters/,
    "101 characters is refused before any page opens",
  );
  console.log("OK T1: 100 characters passes, 101 is refused");
}

// --- T2: a result word anywhere in the line, not just the hook ----------------------------------
{
  const line = `${rankedTitle("A CLOSE ONE")} | WINNER REVEALED`;
  // House rule "Nothing names the winner": the hook here is clean, so only a whole-line read catches it.
  assert.match(String(titleTestProblem(line, players)), /gives the result away/);
  console.log("OK T2: a spoiler outside the hook segment is refused");
}

// --- T3: no seed, rank or elo in a TC hook --------------------------------------------------------
{
  // House rule: "No seed, rank or elo in hooks or suggestions" — they change daily and do not
  // predict views; a TC challenger is a hook like any other.
  assert.match(
    String(titleTestProblem(rankedTitle("THE #1 SEED'S TOUGHEST TEST"), players)),
    /seed, rank or elo/,
  );
  console.log("OK T3: a seed in the hook is refused (hookProblem runs)");
}

// --- T4: label check against the match's own two players ----------------------------------------
{
  // 2 Oct 2026: invented "X vs Y" nicknames went out in hooks and runners objected in public.
  assert.match(
    String(titleTestProblem(rankedTitle("SPEEDSTER VS NEWCOMER"), players)),
    /label/,
    "an invented pair in the hook is a label",
  );
  // The match's own two players are not a label, in any case.
  const own = `${players[0]!.nickname} VS ${players[1]!.nickname}`.toUpperCase();
  assert.equal(titleTestProblem(rankedTitle(own), players), null, "the match's own pair is fine");
  // titleNames spelling ("lowkey" for lowk3y_) counts as the player's own name too.
  assert.equal(titleTestProblem(gfTitle("LOWKEY VS INFUME"), gfPlayers), null, "titleNames spelling");
  console.log("OK T4: an invented pair is refused; the match's own pair (API or titleNames) is not");
}

// --- T5: fail closed with no players at hand ----------------------------------------------------
{
  // "A model's proposal and a carried hookText value both fail closed": with nobody to compare
  // against, any pair is treated as a label rather than waved through.
  const own = `${players[0]!.nickname} VS ${players[1]!.nickname}`;
  assert.match(String(titleTestProblem(rankedTitle(own), [])), /label/);
  console.log("OK T5: with no players known, any X vs Y hook is refused");
}

// --- T6: what the channel actually ran is never refused -----------------------------------------
{
  // Both arms of the first finished live title test (_2EOkOOX0PQ, 8-11 Oct 2026). "A SUB-9 TO WIN
  // IT" is the sanctioned pace stake: it says what winning takes, not who did.
  assert.equal(titleTestProblem(gfTitle("IT ALL COMES DOWN TO THE END"), gfPlayers), null);
  assert.equal(titleTestProblem(gfTitle("A SUB-9 TO WIN IT"), gfPlayers), null);
  // The documented lead-change chip, and an upset framed as a question ("The upset hook is a question").
  assert.equal(titleTestProblem(rankedTitle("DOES THE LEAD EVER SETTLE?"), players), null);
  assert.equal(titleTestProblem(rankedTitle("CAN THE UNDERDOG PULL IT OFF?"), players), null);
  console.log("OK T6: live-run titles, the lead-change chip and an upset question all pass");
}

// --- T7: a label in the title's own "X vs Y" slot ------------------------------------------------
deviation(
  'CLAUDE.md House rules: "a fresh X vs Y is checked against the match\'s own two players … a mismatch is a label too"',
  () => {
    // A challenger title is wholly new text: rewriting one runner's name in the pair slot into an
    // epithet is exactly the 2 Oct 2026 failure, just one segment to the right of the hook.
    const relabelled = `A CLOSE ONE | SPEEDSTER vs ${players[1]!.nickname} | MCSR Ranked 1v1 | Minecraft Speedrun`;
    assert.notEqual(
      titleTestProblem(relabelled, players),
      null,
      `titleTestProblem(${JSON.stringify(relabelled)}, ${JSON.stringify(players)}) returned null`,
    );
  },
);

// --- R1: when a test is done -----------------------------------------------------------------------
{
  // "Studio's 'Results ready'/'Test finished' means done" (CLAUDE.md). Both words alone suffice.
  assert.equal(parseTcReport("A/B Testing titles\nResults ready\nView test report").done, true);
  assert.equal(
    parseTcReport("Test finished. Ran from October 8, 2026 at 11:00 PM to October 11, 2026 at 11:31 AM.")
      .done,
    true,
    "the report's own 'Test finished' line alone means done",
  );
  // Live text of the channel's first running test (LUI5E7yF0zE, 8 Oct 2026): still running.
  assert.equal(parseTcReport("Test running… · Estimated time remaining: 13 days 23 hours").done, false);
  // An unreadable/empty page is not a finished test.
  const empty = parseTcReport("");
  assert.equal(empty.done, false);
  assert.equal(empty.winnerSlot, undefined, "nothing read, no winner");
  console.log("OK R1: Results ready / Test finished are done; running and empty are not");
}

// --- R2 / R3: the winner comes only from Studio's own mark ---------------------------------------
{
  const v = (title: string, share: string, extra: { visible?: boolean; winner?: boolean } = {}) => [
    "35:46",
    title,
    "MCSR Replayoffs",
    ...(extra.visible ? ["Now visible to all viewers"] : []),
    share,
    "Watch time share",
    ...(extra.winner ? ["Winner"] : []),
  ];
  const head = ["Title only", "A/B Test report"];
  const tail = ["Set this option", "Test finished. Ran from October 8, 2026 to October 11, 2026.", "Done"];
  const a = rankedTitle("A CLOSE ONE");
  const b = rankedTitle("DOES THE LEAD EVER SETTLE?");

  // R2: an 80/20 split with no "Winner" line. The live one stays "Now visible"; that is not a win.
  const lopsided = parseTcReport(
    [...head, "They all performed well", ...v(a, "80.0%", { visible: true }), ...v(b, "20.0%"), ...tail].join(
      "\n",
    ),
  );
  assert.equal(lopsided.done, true);
  assert.deepEqual(lopsided.shares, [80, 20], "shares in slot order");
  // "The worker never sets a Test & Compare winner itself": a big share is not Studio's verdict.
  assert.equal(lopsided.winnerSlot, undefined, "no Winner mark, no winner — never inferred from shares");

  // R3: the challenger won and YouTube applied it — both marks sit on slot 2.
  const slot2 = parseTcReport(
    [
      ...head,
      "We have a winner!",
      ...v(a, "41.3%"),
      ...v(b, "58.7%", { visible: true, winner: true }),
      ...tail,
    ].join("\n"),
  );
  assert.equal(slot2.done, true);
  assert.deepEqual(slot2.shares, [41.3, 58.7]);
  assert.equal(slot2.winnerSlot, 2, "Studio's own Winner mark on the challenger");
  assert.deepEqual(slot2.titles, [a, b], "titles in slot order, so the worker can credit the arm by title");
  assert.equal(slot2.headline, "We have a winner!");
  console.log("OK R2/R3: no Winner mark gives no winner; a consistent slot-2 mark is read as slot 2");
}

console.log(`studioActions.contract: all checks passed (${deviations.length} documented deviation(s))`);
