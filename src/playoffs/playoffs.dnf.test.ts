// Self-check for the DNF verdict (`matchIsDnf`), from the rule alone. The operator, 16 Oct 2026:
// "remember not to post DNF matches also dont suggest them", then "playoffs dont have rules they are
// always posted as is". So a ranked match nobody finished is kept off the channel, and a playoff
// game — single or in a series, forfeited or not — never is. Every gate past this one in
// playoffs.dnfExempt.contract.test.ts.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/playoffs/playoffs.dnf.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { dnfRefusal, matchIsDnf, type PlayoffSeries } from "./playoffs.js";

const finished = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const forfeit: MatchInfo = { ...finished, forfeited: true, completions: [] };
const served = (m: MatchInfo) => async () => m;
const noSeries = async () => null;
const inSeries = async () => ({ games: [] }) as unknown as PlayoffSeries;

// --- A ranked match --------------------------------------------------------------------------------
assert.equal(await matchIsDnf(1, served(finished), noSeries), false, "a finished ranked match goes ahead");
assert.equal(await matchIsDnf(1, served(forfeit), noSeries), true, "a forfeited ranked match is a DNF");
assert.equal(
  await matchIsDnf(1, served({ ...finished, result: { ...finished.result, uuid: null } }), noSeries),
  true,
  "no winner is a DNF",
);
assert.equal(
  await matchIsDnf(1, served({ ...finished, completions: [] }), noSeries),
  true,
  "no completion is a DNF",
);
console.log("OK: a ranked match is a DNF when nobody finished, and only then");

// --- A playoff game: posted as is ------------------------------------------------------------------
assert.equal(
  await matchIsDnf(2, served(forfeit), inSeries),
  false,
  "a forfeited playoff game is never a DNF",
);
assert.equal(
  await matchIsDnf(2, served({ ...forfeit, result: { ...forfeit.result, uuid: null } }), inSeries),
  false,
  "nor one with no winner",
);
// The bracket is never even asked about a finished match.
let asked = 0;
await matchIsDnf(1, served(finished), async () => (asked++, null));
assert.equal(asked, 0, "a finished match costs no bracket read");
console.log("OK: a playoff game is never a DNF, forfeited or not");

// --- A down API refuses nothing, and says so -------------------------------------------------------
{
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const down = async () => {
      throw new Error("MCSR Ranked API /matches/5 -> 503");
    };
    assert.equal(await matchIsDnf(5, down, noSeries), false, "an unreadable match is not refused");
    const noBracket = async () => {
      throw new Error("MCSR Ranked API /playoffs/11 -> 503");
    };
    assert.equal(
      await matchIsDnf(6, served(forfeit), noBracket),
      false,
      "nor a forfeit whose bracket is unreadable",
    );
  } finally {
    console.error = error;
  }
  assert.ok(
    logged.some((l) => /match 5: DNF check skipped — .*503/.test(l)),
    `logged: ${logged.join(" | ")}`,
  );
}
assert.equal(dnfRefusal(7, "it is not rendered"), "match 7 is a DNF (nobody finished) — it is not rendered");
console.log("OK: a down API or bracket refuses nothing; the refusal reads the same everywhere");

console.log("playoffs.dnf: all checks passed");
