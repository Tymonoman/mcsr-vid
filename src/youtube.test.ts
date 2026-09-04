import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { parseImpressionsCsv, REQUIRED_SCOPES } from "./youtube.js";
import { findExportedVideo } from "./youtubeStore.js";

// --- Reporting CSV: the only source of per-video CTR, so a misread here silently corrupts
// every A/B conclusion drawn from it.

const csv = [
  "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr",
  "20260901,UCm2mAyONTHlmIxZzNmi388w,vid_aaa,1200,0.043",
  "20260902,UCm2mAyONTHlmIxZzNmi388w,vid_aaa,900,0.051",
  "20260902,UCm2mAyONTHlmIxZzNmi388w,vid_bbb,400,0.028",
].join("\n");

const rows = parseImpressionsCsv(csv);
assert.equal(rows.length, 3);
assert.deepEqual(rows[0], { date: "20260901", videoId: "vid_aaa", impressions: 1200, ctr: 0.043 });
assert.equal(rows[2]!.videoId, "vid_bbb");

// Columns are located by name, not position. A column added upstream must not shift the CTR
// into the impressions slot — which is exactly the kind of bug nobody notices for a month.
const reordered = [
  "video_thumbnail_impressions_ctr,video_id,date,channel_id,video_thumbnail_impressions",
  "0.043,vid_aaa,20260901,UCxxx,1200",
].join("\n");
assert.deepEqual(parseImpressionsCsv(reordered)[0], {
  date: "20260901",
  videoId: "vid_aaa",
  impressions: 1200,
  ctr: 0.043,
});

// A report with only a header is "no data yet", which is the normal case for the first ~48h.
assert.deepEqual(
  parseImpressionsCsv("date,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr"),
  [],
);
assert.deepEqual(parseImpressionsCsv(""), []);

// A CSV missing the metrics is reported loudly rather than quietly yielding zeroes, because
// zero impressions and "we could not find the column" look identical downstream.
assert.throws(() => parseImpressionsCsv("date,video_id\n20260901,vid_aaa"), /missing expected columns/);

// force-ssl is what allows replying to a comment; without it the dashboard can read threads but
// not answer them, which is half the feature.
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/youtube.force-ssl"));
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/youtube.upload"));
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/yt-analytics.readonly"));

// --- Finding the exported video. The pipeline produces a Kdenlive project, not a finished
// file, so this picks which file to upload — and picking wrong means a multi-GB POV clip on a
// public channel.

const matchId = 999000111;
const dir = path.join(config.mediaDir, String(matchId));
await mkdir(dir, { recursive: true });

// Nothing exported yet: say what to do, not just "not found".
const none = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in none && /Export the finished render/.test(none.error));

// The POV clips and render intermediates are never candidates, however many there are.
await writeFile(path.join(dir, "nahhann.mp4"), "pov", "utf8");
await writeFile(path.join(dir, "Aquacorde.mp4"), "pov", "utf8");
await writeFile(path.join(dir, "overlay.mov"), "intermediate", "utf8");
await writeFile(path.join(dir, "overlay-intro.mov"), "intermediate", "utf8");
await writeFile(path.join(dir, "sync-preview.mp4"), "preview", "utf8");
const stillNone = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in stillNone, "POV clips and intermediates must never be upload candidates");

// One export: found.
await writeFile(path.join(dir, "final-render.mp4"), "the actual video", "utf8");
const found = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("path" in found);
assert.equal(path.basename(found.path), "final-render.mp4");

// Two exports: refuse and name them. Guessing here is the expensive kind of wrong.
await writeFile(path.join(dir, "final-render-v2.mp4"), "another take", "utf8");
const ambiguous = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in ambiguous && /Several possible videos/.test(ambiguous.error));
assert.match((ambiguous as { error: string }).error, /final-render\.mp4/);
assert.match((ambiguous as { error: string }).error, /final-render-v2\.mp4/);

await rm(dir, { recursive: true, force: true });
console.log("youtube: all checks passed");
