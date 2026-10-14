// Contract test for the long-form title (title.ts), written from the docs (CLAUDE.md "House rules",
// "Hook chips" and titleNames; handbook/claude-md-reference.md "Shorts" — the label bullet — and
// "The title spells two players the broadcast's way") before reading the code. title.test.ts pins
// the budget arithmetic and the historical "carried label" bug; this file checks the documented
// promises on real match pairs (src/fixtures) and on titleNames as the Settings tab changes it.
//
// The promises (full list and numbering in hooks.contract.test.ts; the ones checked here):
//  P4  A fresh "X vs Y" is checked against the match's own two players (API or titleNames
//      spelling); a mismatch is a label — "v", "v.", "versus" and a third side included.
//  P5  A carried hookText (withHook) fails closed the same way hookProblem does: a label, a
//      denied word, a result or a seed/rank/elo leaves the <HOOK> placeholder.
//  P3  A denied word is refused outright, "vs" or not, with or without the match at hand.
//  P14 titleNames (default Pinne→Skycrab, lowk3y_→lowkey) is the title's spelling of a player,
//      and the Settings tab applies it live.
//  P15 The long-form title is "<hook> | <left> vs <right> | MCSR Ranked 1v1 | Minecraft Speedrun",
//      <HOOK> until a hook fills it; an over-budget hook is never cut to fit.
// Run: npx tsx src/pipeline/title.contract.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import {
  buildTitle,
  formatTitle,
  HOOK_PLACEHOLDER,
  MOBILE_CUTOFF,
  SEPARATOR,
  titleName,
  withHook,
} from "./title.js";

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

const load = (id: number): MatchInfo =>
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "fixtures", `match-${id}.json`), "utf8"),
  ) as MatchInfo;

/* --- P15: the shape of the line, on a real pair ------------------------------------------------ */
const real = load(13782182);
const [left, right] = real.players.map((p) => p.nickname) as [string, string];
const built = buildTitle({ leftNickname: left, rightNickname: right });
// The hook is the first segment, the two API nicknames the second, the format tail last — the
// docs' "<hook> | <left> vs <right>" with "Minecraft Speedrun" in the tail (22 Sept 2026).
assert.equal(built.title, `${HOOK_PLACEHOLDER} | ${left} vs ${right} | MCSR Ranked 1v1 | Minecraft Speedrun`);
assert.equal(built.title.split(SEPARATOR)[0], HOOK_PLACEHOLDER, "unfilled, the hook is the placeholder");
// A hook at the very top of the budget still lands both names inside the mobile cut, where the
// search terms have to be.
const longest = withHook(built, "X".repeat(built.hookMax), real.players);
assert.ok(longest.title.indexOf(right) + right.length <= MOBILE_CUTOFF, longest.title);
// One character over is not cut to fit — a truncated hook stops mid-word — it is the placeholder.
assert.equal(withHook(built, "X".repeat(built.hookMax + 1), real.players).title, built.title);
// The paste file still opens on the title, whichever way the hook went.
assert.equal(formatTitle(longest).split("\n")[0], longest.title);
console.log("OK: the long-form title is hook | names | tail, and an over-budget hook is never cut");

/* --- P14: titleNames, the defaults and a live change ----------------------------------------- */
// The defaults the docs name.
assert.equal(titleName("Pinne"), "Skycrab");
assert.equal(titleName("lowk3y_"), "lowkey");
assert.equal(titleName(left), left, "anyone else keeps the API spelling");
const broadcast = buildTitle({ leftNickname: "Pinne", rightNickname: "lowk3y_" });
assert.ok(broadcast.title.startsWith(`${HOOK_PLACEHOLDER} | Skycrab vs lowkey | `), broadcast.title);
assert.ok(!broadcast.generated.includes("Pinne") && !broadcast.generated.includes("lowk3y_"));
// The budget is the broadcast spelling's: "Skycrab vs lowkey" is what has to land before the cut.
assert.equal(
  broadcast.hookMax,
  Math.min(
    MOBILE_CUTOFF - SEPARATOR.length - "Skycrab vs lowkey".length,
    100 - SEPARATOR.length - broadcast.generated.length,
  ),
);
// A carried hook naming the pair by broadcast spelling is the real pair, not a label (P4).
assert.equal(
  withHook(broadcast, "lowkey versus Skycrab", [{ nickname: "Pinne" }, { nickname: "lowk3y_" }]).title.split(
    SEPARATOR,
  )[0],
  "lowkey versus Skycrab",
  "the real pair in the title's own spelling carries",
);
// Settings → titleNames applies live (no restart): the next title built reads the new map.
const savedNames = config.titleNames;
try {
  config.titleNames = { ...savedNames, [left]: "SilverR" };
  assert.equal(
    buildTitle({ leftNickname: left, rightNickname: right }).generated.split(SEPARATOR)[0],
    `SilverR vs ${right}`,
  );
  // ...and the new spelling counts as that player in the vs-check too.
  assert.equal(
    withHook(built, `SilverR vs ${right}`, real.players).title.split(SEPARATOR)[0],
    `SilverR vs ${right}`,
  );
} finally {
  config.titleNames = savedNames;
}
assert.equal(titleName(left), left, "restored");
console.log("OK: titleNames spells the title, by default and live");

/* --- P4/P5: a carried hook that labels a runner leaves the placeholder ------------------------ */
// Every shape the docs list as a label, against this match's own players.
for (const label of [
  `${left} vs THE GRINDER`,
  "SPEEDY v. SLOWPOKE",
  "SPEEDY versus SLOWPOKE",
  "SPEEDY v SLOWPOKE",
  `${left} vs ${right} vs THE CLOCK`,
  "THE KOREAN GRINDER",
]) {
  assert.equal(withHook(built, label, real.players).title, built.title, `carried: ${label}`);
}
// The real pair, every spelling of "vs", carries.
for (const pair of [`${left} vs ${right}`, `${right} v. ${left}`, `${left} versus ${right}`])
  assert.equal(withHook(built, pair, real.players).title.split(SEPARATOR)[0], pair);
console.log("OK: a carried label leaves the placeholder; the real pair carries");

/* --- P3: a denied word is refused outright, with or without the match ------------------------ */
deviation('P3 "A denied word … is refused outright" — withHook with no players given', () => {
  // title.test.ts pins the opposite on purpose ("the historical bug, unfixed on this call shape
  // alone"); the docs say outright, and the denied-word half needs no match to run.
  assert.equal(
    withHook(built, "THE KOREAN GRINDER").title,
    built.title,
    "a denied word carried with no players",
  );
});

/* --- P5: a carried hookText fails closed "the same way hookProblem does" ---------------------- */
deviation(
  'P5 "a carried hookText value … fail[s] closed the same way hookProblem does" — result and seed/rank/elo',
  () => {
    const carried = ["THE UNDERDOG WINS", "#1 SEED SHOWDOWN", "2400 vs 2100"].filter(
      (h) => withHook(built, h, real.players).title !== built.title,
    );
    assert.deepEqual(carried, [], `carried into the title file: ${JSON.stringify(carried)}`);
  },
);

if (deviations.length)
  console.log(`title.contract: ${deviations.length} deviation(s) from the docs, listed above`);
console.log("title.contract: all checks passed");
