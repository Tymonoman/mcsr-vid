// Contract test for the description's chapter list (src/pipeline/chapters.ts), written from the
// docs as an outside engineer would, against real matches in src/fixtures/.
// Run: npx tsx src/pipeline/chapters.contract.test.ts
//
// What the docs promise (CLAUDE.md, handbook/claude-md-reference.md "Known pitfalls", "Playoffs",
// README "Each match produces"):
//  1. Every match ships chapters, and they are YouTube-valid: the first at 0:00, then ascending,
//     each at least 10 s after the one before ("YouTube's 10s minimum").
//  2. A chapter is a race checkpoint (or Start / Result), never a player, a seed number or a
//     score: "Nothing names the winner", "no seed, rank or elo".
//  3. The chapters are written at render time, before any export, so they follow export:fast's
//     head trim (`headTrimSec(config.introSec)`): match start lands at introSec + 3 s
//     (7 -> 0:10, 3 -> 0:06), and every split chapter sits that far plus its first arrival.
//  4. The Result chapter marks when the race ends, under a label that names nobody.
//  5. A series runs to fifty minutes and more: past the hour a chapter reads H:MM:SS, and every
//     line still opens with a timestamp YouTube can read.
//
// Already pinned by chapters.test.ts and not repeated here: first-arrival (min) timing, a lone
// side still counting, the greedy 10 s filter's own edge cases, a 3 s card being 4 s earlier.
//
// Limit: `leadInFor` rebuilds pipeline.ts's lead-in (`overlayLeadInSec - headTrimSec(introSec)`)
// rather than run the pipeline, so the `introSec + 3` assert pins the constants and headTrimSec,
// not that runPipeline really hands this lead-in to buildChapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChapters, formatChapters, formatChapterTime } from "./chapters.js";
import { computeSplits } from "./overlayProps.js";
import { headTrimSec } from "./exportFast.js";
import { config } from "../config.js";
import type { MatchInfo } from "../api/types.js";

const FIXTURES = [
  12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13560037, 13617328, 13673240,
  13766294, 13782182,
];
const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

/** Where the description's chapters put match start, as the render computes it (pipeline.ts). */
const leadInFor = (introSec: number) => config.overlayLeadInSec - headTrimSec(introSec);

// The only labels a single match's chapter list may carry: the overlay's split names plus the
// two bookends. A closed list, so a player name, "#3 seed" or "2-1" cannot sneak in.
const ALLOWED = new Set([
  "Start",
  "Nether Enter",
  "Bastion",
  "Fortress",
  "Blind",
  "Stronghold Enter",
  "End Enter",
  "Result",
]);

for (const id of FIXTURES) {
  const match = load(id);
  const [left, right] = match.players;
  const splits = computeSplits(match, left!.uuid, right!.uuid);

  for (const introSec of [2, 3, 4, 5, 6, 7]) {
    const leadIn = leadInFor(introSec);
    const chapters = buildChapters(splits, match, leadIn);

    // 1. YouTube ignores the whole list unless it opens at 0:00 and every chapter is 10 s+ long.
    assert.equal(chapters[0]!.timeSec, 0, `${id}: the first chapter must be 0:00`);
    assert.ok(chapters.length >= 3, `${id}: a real race yields a usable list, got ${chapters.length}`);
    for (let i = 1; i < chapters.length; i++) {
      const gap = chapters[i]!.timeSec - chapters[i - 1]!.timeSec;
      assert.ok(
        gap >= 10,
        `${id} (introSec ${introSec}): "${chapters[i]!.label}" is ${gap}s after "${chapters[i - 1]!.label}" — YouTube needs 10s, ascending`,
      );
    }
    // The formatted text too: YouTube reads the integer seconds it prints, not the float behind it,
    // so a 10.4 s gap rounding down to 9 would void the list just the same.
    const printed = formatChapters(chapters)
      .split("\n")
      .map((line) =>
        line
          .split(" ")[0]!
          .split(":")
          .reduce((acc, part) => acc * 60 + Number(part), 0),
      );
    for (let i = 1; i < printed.length; i++)
      assert.ok(
        printed[i]! - printed[i - 1]! >= 10,
        `${id}: printed chapters ${printed.join(",")} under 10s apart`,
      );

    // 2. Names nobody: every label is a checkpoint or a bookend, never a nickname.
    for (const c of chapters) {
      assert.ok(ALLOWED.has(c.label), `${id}: unexpected chapter label "${c.label}"`);
      for (const p of match.players)
        assert.ok(
          !c.label.toLowerCase().includes(p.nickname.toLowerCase()),
          `${id}: "${c.label}" names ${p.nickname}`,
        );
    }

    // 3. The head trim: match start at introSec + 3 s, so a split chapter is that plus its first
    // arrival. (A chapter dropped by the 10 s filter is not checked — it is not in the list.)
    assert.equal(
      leadIn,
      introSec + 3,
      "match start lands at introSec + 3 s in the MP4 (CLAUDE.md, intro card)",
    );
    for (const c of chapters.slice(1)) {
      const row = splits.find((r) => r.label === c.label);
      if (!row) continue; // the Result chapter, below
      const first = Math.min(...[row.leftMs, row.rightMs].filter((t): t is number => t !== null));
      assert.equal(
        c.timeSec,
        leadIn + first / 1000,
        `${id}: ${c.label} must sit at match start + first arrival`,
      );
    }

    // 4. The Result chapter (when the 10 s filter keeps it) sits where the race ends, labelled
    // "Result" and nothing more — when, never who.
    const result = chapters.find((c) => c.label === "Result");
    if (match.result.time > 0 && result) assert.equal(result.timeSec, leadIn + match.result.time / 1000);
  }
}

// 5. Past the hour: H:MM:SS, so a series' later games keep a chapter YouTube can read.
assert.equal(formatChapterTime(59 * 60 + 59.9), "59:59", "the last second of the first hour, floored");
assert.equal(formatChapterTime(3600), "1:00:00", "the hour itself is H:MM:SS, not 60:00");
assert.equal(formatChapterTime(3725.9), "1:02:05", "minutes and seconds keep two digits past the hour");
assert.equal(formatChapterTime(-3), "0:00", "nothing before 0:00");
{
  const long = formatChapters([
    { label: "game 1 · village seed", timeSec: 0 },
    { label: "Nether Enter", timeSec: 1754.2 },
    { label: "game 6 · shipwreck seed", timeSec: 3600 },
    { label: "Result", timeSec: 4210.7 },
  ]);
  assert.equal(
    long,
    "0:00 game 1 · village seed\n29:14 Nether Enter\n1:00:00 game 6 · shipwreck seed\n1:10:10 Result",
  );
  for (const line of long.split("\n"))
    assert.match(line, /^(?:\d+:)?\d{1,2}:\d{2} \S/, "every line opens with a timestamp YouTube reads");
}

console.log("chapters.contract: all checks passed");
