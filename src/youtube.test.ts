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

// --- Impressions-weighted CTR. This is the number the A/B table picks a pose from, so getting
// it wrong silently recommends the worse thumbnail.

const { totalReach } = await import("./youtubeRoutes.js");

// A quiet day must not outvote a busy one: the naive mean of 1% and 10% is 5.5%, but 1000
// impressions at 1% next to 10 at 10% is really 1.09%.
const mixed = totalReach([
  { date: "20260901", videoId: "v", impressions: 1000, ctr: 0.01 },
  { date: "20260902", videoId: "v", impressions: 10, ctr: 0.1 },
]);
assert.equal(mixed.impressions, 1010);
assert.ok(Math.abs(mixed.weightedCtr / mixed.impressions - 0.0109) < 0.0001);

// weightedCtr stays undivided so per-video totals can be summed again per variant.
const one = totalReach([{ date: "d", videoId: "v1", impressions: 100, ctr: 0.05 }]);
const two = totalReach([{ date: "d", videoId: "v2", impressions: 300, ctr: 0.01 }]);
const group = {
  impressions: one.impressions + two.impressions,
  weightedCtr: one.weightedCtr + two.weightedCtr,
};
assert.equal(group.weightedCtr / group.impressions, 0.02);

// No rows, and rows with no impressions, must not divide by zero.
assert.deepEqual(totalReach([]), { impressions: 0, weightedCtr: 0 });
assert.deepEqual(totalReach([{ date: "d", videoId: "v", impressions: 0, ctr: 0 }]), {
  impressions: 0,
  weightedCtr: 0,
});

console.log("youtube: all checks passed");
