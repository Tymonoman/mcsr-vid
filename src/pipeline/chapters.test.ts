import assert from "node:assert/strict";
import { buildChapters, type ChapterMarker, filterChapterGap, formatChapters } from "./chapters.js";
import type { SplitRow } from "./overlayProps.js";
import type { MatchInfo } from "../api/types.js";

const match = (resultTimeMs: number) => ({ result: { uuid: null, time: resultTimeMs } }) as MatchInfo;

const splits: SplitRow[] = [
  { label: "Nether Enter", leftMs: 126000, rightMs: 107000 }, // first arrival: 107s
  { label: "Bastion", leftMs: 156000, rightMs: 138000 }, // 138s
  { label: "Fortress", leftMs: null, rightMs: 271000 }, // DNF for left, right still counts
  { label: "Blind", leftMs: null, rightMs: null }, // neither reached it — dropped entirely
  { label: "Stronghold Enter", leftMs: 400000, rightMs: 398000 }, // 398s
  { label: "End Enter", leftMs: 441000, rightMs: 440000 }, // 440s
];

const chapters = buildChapters(splits, match(518512), 20);

assert.equal(chapters[0].label, "Start");
assert.equal(chapters[0].timeSec, 0, "first chapter must be at 0:00 per YouTube's requirement");
assert.equal(
  chapters.map((c) => c.label).join(","),
  "Start,Nether Enter,Bastion,Fortress,Stronghold Enter,End Enter,Result",
  "Blind must be dropped (both players null) and the rest kept in order, Stronghold Enter included",
);
assert.equal(chapters[1].timeSec, 20 + 107, "uses the first (min) arrival, plus the lead-in offset");
assert.equal(chapters[3].timeSec, 20 + 271, "a lone non-null side still produces a chapter");
assert.equal(chapters[4].timeSec, 20 + 398, "Stronghold Enter chapter uses the first arrival");
assert.equal(chapters[6].timeSec, 20 + 518.512, "Result chapter comes from match.result.time");

const text = formatChapters(chapters);
assert.equal(text.split("\n")[0], "0:00 Start");
assert.match(text, /^\d+:\d{2} /m, "every line must be `M:SS Label`");

// Two splits inside the 10s YouTube minimum gap: only the first survives.
const tight: SplitRow[] = [
  { label: "A", leftMs: 20000, rightMs: null }, // 20s after Start — kept
  { label: "B", leftMs: 25000, rightMs: null }, // 5s after A — must be dropped
  { label: "C", leftMs: 40000, rightMs: null }, // 20s after A — must survive
];
const tightChapters = buildChapters(tight, match(0), 0);
assert.equal(
  tightChapters.map((c) => c.label).join(","),
  "Start,A,C",
  "B is within the 10s minimum gap of A and must be dropped",
);

// The description's chapters follow export:fast's head trim: match start at introSec + 3 s.
{
  const { headTrimSec } = await import("./exportFast.js");
  const at = (introSec: number) =>
    buildChapters(splits, match(518512), 10 - headTrimSec(introSec))[1]!.timeSec;
  assert.equal(at(7) - at(3), 4, "a 3 s card puts every chapter 4 s earlier");
  assert.equal(at(7), buildChapters(splits, match(518512), 10)[1]!.timeSec, "a 7 s card is today's");
}

// filterChapterGap: shared by buildChapters and a series' merged, multi-game list
// (buildSeriesDescription, description.ts). The first chapter is always kept, even at 0.
{
  const list: ChapterMarker[] = [
    { label: "A", timeSec: 0 },
    { label: "B", timeSec: 9 }, // under 10s of A — dropped
    { label: "C", timeSec: 10 }, // exactly 10s of A — kept (the YouTube minimum is inclusive)
    { label: "D", timeSec: 15 }, // under 10s of C, the last KEPT one — dropped
  ];
  assert.deepEqual(
    filterChapterGap(list).map((c) => c.label),
    ["A", "C"],
    "B and D are each within 10s of the previous KEPT chapter",
  );
  assert.deepEqual(filterChapterGap([]), [], "an empty list stays empty");
  assert.deepEqual(filterChapterGap([list[0]!]), [list[0]], "a single chapter is always kept");
  assert.deepEqual(
    filterChapterGap(list, 5).map((c) => c.label),
    ["A", "B", "D"],
    "a smaller minGapSec keeps more (C is still within 5s of B, the last kept one)",
  );
}

console.log("chapters: all checks passed");
