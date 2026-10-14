// Real-ffmpeg round trip for a series' join and the extraction that undoes it (series.ts): three
// tiny exports joined as `assembleSeries` joins them, each game taken back out, re-joined with one
// game "re-exported" and taken back out again. Every game must come back packet for packet — the
// stub seams in series.test.ts cannot see this. Before 14 Oct 2026 an input seek at the chapter
// offset landed on the previous game's last GOP (the join moves the video ~21 ms later), so every
// game after the first came back with the one before's ending in front, one more GOP per re-join.
// Both encoders export:fast uses: h264_vaapi (no B-frames, 120-frame GOP) and the libx264 fallback.
// Run: npx tsx src/playoffs/seriesExtract.test.ts (drives ffmpeg: in `npm test`, not test:unit)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chapterStarts, concatVideos, extractFromSeries, probeDuration } from "./series.js";

const dir = mkdtempSync(path.join(tmpdir(), "series-extract-"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** md5 of every video packet, in order — no decode, so equal lists are the same bitstream. */
const packets = (file: string): string[] =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-c", "copy", "-f", "framemd5", "-"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").pop()!.trim());

const encoders: Record<string, string[]> = {
  vaapi: ["-c:v", "libx264", "-preset", "veryfast", "-bf", "0", "-g", "120"],
  x264: ["-c:v", "libx264", "-preset", "veryfast"],
};
try {
  for (const [name, video] of Object.entries(encoders)) {
    // Each game its own picture (a different hue) and length, 60 fps + AAC 48k like an export.
    const games = [3.5, 4.2, 2.9].map((sec, i) => {
      const out = path.join(dir, `${name}-game${i + 1}.mp4`);
      ff([
        ...["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=60:duration=${sec}`],
        ...["-f", "lavfi", "-i", `sine=frequency=${440 * (i + 1)}:sample_rate=48000:duration=${sec}`],
        ...["-vf", `hue=h=${i * 120}`, "-pix_fmt", "yuv420p", "-threads", "1", ...video],
        ...["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out],
      ]);
      return out;
    });
    // The join itself puts the parameter sets in band on each keyframe (the concat demuxer's
    // mp4-to-Annex B), so a game's packets are its slice of the first join, not its export's bytes.
    const series = path.join(dir, `${name}-series.mp4`);
    await concatVideos(games, series);
    const joined = packets(series);
    const counts = games.map((g) => packets(g).length);
    assert.equal(joined.length, counts[0]! + counts[1]! + counts[2]!, `${name}: the join keeps every packet`);
    const want = chapterStarts(counts).map((at, i) => joined.slice(at, at + counts[i]!));
    const takeOut = async (from: string, finals: readonly string[], which: number[], round: number) => {
      const starts = chapterStarts(await Promise.all(finals.map(probeDuration)));
      const durations = await Promise.all(finals.map(probeDuration));
      const outs: string[] = [];
      for (const i of which) {
        const out = path.join(dir, `${name}-r${round}-game${i + 1}.mp4`);
        await extractFromSeries(from, starts[i]!, durations[i]!, out);
        assert.deepEqual(
          packets(out),
          want[i],
          `${name}, round ${round}: game ${i + 1} back packet for packet`,
        );
        outs[i] = out;
      }
      return outs;
    };
    const first = await takeOut(series, games, [0, 1, 2], 1);

    // The documented re-join twice over: game 3 re-exported, games 1 and 2 taken back out of the
    // series they are in, joined again — nothing may grow.
    let finals = [first[0]!, first[1]!, games[2]!];
    for (const round of [2, 3]) {
      const rejoined = path.join(dir, `${name}-series-r${round}.mp4`);
      await concatVideos(finals, rejoined);
      const back = await takeOut(rejoined, finals, [0, 1], round);
      finals = [back[0]!, back[1]!, games[2]!];
      assert.deepEqual(
        packets(rejoined),
        want.flat(),
        `${name}, round ${round}: the series holds each game once`,
      );
    }
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".extract-")),
      [],
      "no segment is left beside a game",
    );
    console.log(`OK: ${name} — every game comes back out of the series exactly, re-join after re-join`);
  }

  // A record that does not describe the file is refused, never cut at a guess.
  const stray = path.join(dir, "stray.mp4");
  await assert.rejects(
    extractFromSeries(path.join(dir, "vaapi-series.mp4"), 1.0, 2, stray),
    /no keyframe at/,
  );
  assert.ok(!existsSync(stray));
  console.log("OK: an offset with no keyframe is refused");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("seriesExtract: all checks passed");
