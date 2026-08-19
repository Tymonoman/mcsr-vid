import assert from "node:assert/strict";
import { buildChapters, formatChapters } from "./chapters.js";
import type { SplitRow } from "./overlayProps.js";
import type { MatchInfo } from "./types.js";

const match = (resultTimeMs: number) => ({ result: { uuid: null, time: resultTimeMs } }) as MatchInfo;

const splits: SplitRow[] = [
  { label: "Nether Enter", leftMs: 126000, rightMs: 107000 }, // first arrival: 107s
  { label: "Bastion", leftMs: 156000, rightMs: 138000 }, // 138s
  { label: "Fortress", leftMs: null, rightMs: 271000 }, // DNF for left, right still counts
  { label: "Blind", leftMs: null, rightMs: null }, // neither reached it — dropped entirely
  { label: "End Enter", leftMs: 441000, rightMs: 440000 }, // 440s
];

const chapters = buildChapters(splits, match(518512), 20);

assert.equal(chapters[0].label, "Start");
assert.equal(chapters[0].timeSec, 0, "first chapter must be at 0:00 per YouTube's requirement");
assert.equal(
  chapters.map((c) => c.label).join(","),
  "Start,Nether Enter,Bastion,Fortress,End Enter,Result",
  "Blind must be dropped (both players null) and the rest kept in order",
);
assert.equal(chapters[1].timeSec, 20 + 107, "uses the first (min) arrival, plus the lead-in offset");
assert.equal(chapters[3].timeSec, 20 + 271, "a lone non-null side still produces a chapter");
assert.equal(chapters[5].timeSec, 20 + 518.512, "Result chapter comes from match.result.time");

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

console.log("chapters: all checks passed");
