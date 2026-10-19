// Self-check for coldOpen.ts: the moment chooser, the join (once, recorded, refused on a stream
// mismatch, undone cleanly) and the chapter shift the upload text applies after it.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES } from "../shorts/raceGap.js";
import { shiftChapterLines } from "./chapters.js";
import { baseExportPath, chooseColdOpen, joinColdOpen, restoreColdOpen, type JoinDeps } from "./coldOpen.js";
import { exportMatchStartSec, readExportRecord, writeExportRecord } from "./exportFast.js";

/** 14224234's race (doogile vs v_strid, 17 Oct 2026): arrivals per milestone [left, right], ms. */
const RACE: Array<[number, number]> = [
  [91_699, 102_327],
  [140_490, 147_299],
  [304_178, 301_300],
  [377_204, 380_578],
  [439_041, 462_797],
  [474_166, 488_803],
];
function race(arr: Array<[number, number] | null>, dragonMs: number | null): MatchInfo {
  const timelines = arr.flatMap((a, i) =>
    a
      ? [
          { uuid: "L", time: a[0], type: MILESTONES[i]!.type },
          { uuid: "R", time: a[1], type: MILESTONES[i]!.type },
        ]
      : [],
  );
  if (dragonMs !== null)
    timelines.push({ uuid: "L", time: dragonMs, type: "projectelo.timeline.dragon_death" });
  return {
    players: [
      { uuid: "L", nickname: "doogile" },
      { uuid: "R", nickname: "v_strid" },
    ],
    timelines,
    result: { uuid: "L", time: (dragonMs ?? 0) + 10_000 },
  } as unknown as MatchInfo;
}

// The closest split at most 5 s apart: the fortress (2.9 s), centred on its two arrivals.
{
  const pick = chooseColdOpen(race(RACE, 518_342), 5)!;
  assert.deepEqual(pick, { fromMs: Math.round((304_178 + 301_300) / 2 - 2500), sec: 5 });
  // Never told the result: the same moment whoever won.
  const flipped = race(RACE, 518_342);
  flipped.result.uuid = "R";
  assert.deepEqual(chooseColdOpen(flipped, 5), pick);
}
// Only mid-race: the first minute and the minute before the dragon are out, and so is a gap over 5 s.
{
  const early: Array<[number, number] | null> = [[40_000, 40_500], null, null, null, null, null];
  assert.equal(chooseColdOpen(race(early, 400_000), 5), null, "inside the first minute");
  const late: Array<[number, number] | null> = [null, null, null, null, [350_000, 350_400], null];
  assert.equal(chooseColdOpen(race(late, 400_000), 5), null, "inside the last minute before the dragon");
  const wide: Array<[number, number] | null> = [
    [100_000, 106_000],
    [200_000, 205_500],
    null,
    null,
    null,
    null,
  ];
  assert.equal(chooseColdOpen(race(wide, 600_000), 5), null, "no split 5 s close");
  assert.equal(
    chooseColdOpen(race(RACE, null), 5),
    null,
    "a game not decided has no last minute to stay out of",
  );
}

// The join: once, recorded, shifting match start; refused on a stream mismatch; undone cleanly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "coldopen-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const id = 42;
  const final = path.join(dir, `final-${id}.mp4`);
  const segment = path.join(dir, "seg.mp4");
  writeFileSync(final, "EXPORT");
  writeFileSync(segment, "COLD");
  const exportedAt = new Date("2026-10-19T03:20:00Z");
  utimesSync(final, exportedAt, exportedAt);
  writeExportRecord(dir, id, {
    matchStartSec: 5,
    encoder: "h264_vaapi",
    coldOpen: { fromMs: 300_239, sec: 5 },
  });

  const streams = (file: string) =>
    readFileSync(file, "utf8") === "OTHER" ? ["x264"] : ["h264 high 1920x1080 60/1"];
  const deps: JoinDeps = {
    probe: async (f) => streams(f),
    duration: async () => 5.0,
    join: async (files, out) => writeFileSync(out, files.map((f) => readFileSync(f, "utf8")).join("+")),
  };

  writeFileSync(segment, "OTHER");
  await assert.rejects(joinColdOpen(dir, id, segment, "LEAD CHANGE AT THE FORTRESS?", deps), /differ/);
  assert.equal(readFileSync(final, "utf8"), "EXPORT", "a refused join leaves the export alone");
  assert.equal(readExportRecord(dir, id)!.coldOpenSec, undefined);

  writeFileSync(segment, "COLD");
  const rec = await joinColdOpen(dir, id, segment, "LEAD CHANGE AT THE FORTRESS?", deps);
  assert.equal(readFileSync(final, "utf8"), "COLD+EXPORT", "the cold open goes in front");
  assert.equal(readFileSync(baseExportPath(dir, id), "utf8"), "EXPORT", "the export is kept as the base");
  assert.deepEqual(
    { start: rec.matchStartSec, sec: rec.coldOpenSec, hook: rec.coldOpenHook },
    { start: 10, sec: 5, hook: "LEAD CHANGE AT THE FORTRESS?" },
  );
  assert.equal(exportMatchStartSec(dir, id), 10, "every consumer reads the shifted match start");
  assert.equal(
    statSync(final).mtime.getTime(),
    exportedAt.getTime(),
    "exportStale still sees the export's own time",
  );

  // Twice is refused, never stacked.
  await assert.rejects(joinColdOpen(dir, id, segment, "ANOTHER HOOK?", deps), /already/);
  assert.equal(readFileSync(final, "utf8"), "COLD+EXPORT");

  // A changed hook: undo, then join again — from the base, so still one cold open.
  const plain = restoreColdOpen(dir, id)!;
  assert.equal(readFileSync(final, "utf8"), "EXPORT");
  assert.equal(existsSync(baseExportPath(dir, id)), false);
  assert.deepEqual(plain, { matchStartSec: 5, encoder: "h264_vaapi", coldOpen: { fromMs: 300_239, sec: 5 } });
  await joinColdOpen(dir, id, segment, "ANOTHER HOOK?", deps);
  assert.equal(readFileSync(final, "utf8"), "COLD+EXPORT");
  assert.equal(readExportRecord(dir, id)!.matchStartSec, 10);
  assert.equal(restoreColdOpen(dir, id)!.matchStartSec, 5);
  assert.deepEqual(restoreColdOpen(dir, id), plain, "restoring a plain export is a no-op");
}

// Chapters move with the cold open; 0:00 stays the video's start; other lines are untouched.
{
  const text = "opening line\n\n0:00 Start\n1:41 Nether\n9:58 Result\n\nPB 6:32.365 tip jar\n#mcsr";
  assert.equal(
    shiftChapterLines(text, 5),
    "opening line\n\n0:00 Start\n1:46 Nether\n10:03 Result\n\nPB 6:32.365 tip jar\n#mcsr",
  );
  assert.equal(shiftChapterLines("0:00 Start\n59:58 Result", 5), "0:00 Start\n1:00:03 Result");
  assert.equal(shiftChapterLines(text, 0), text);
}

console.log("coldOpen: all checks passed");
