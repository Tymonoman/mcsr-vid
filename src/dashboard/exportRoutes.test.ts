import assert from "node:assert/strict";
import { announcedTotalSec, percentOf } from "./exportRoutes.js";

// --- Progress from ffmpeg's log lines. The nightly's export goes through the same job as the
// button's, and ffmpeg never says "percentage:" — the bar sat at 0 for the whole encode.
assert.equal(announcedTotalSec("ffmpeg: 11 split stills, 597.1s at 60fps, h264_vaapi"), 597.1);
assert.equal(
  announcedTotalSec("frame= 1200 fps=60 time=00:00:20.00"),
  null,
  "a stats line announces nothing",
);
assert.equal(
  percentOf(
    "frame=17910 fps= 71 q=-0.0 size=  512000KiB time=00:04:58.55 bitrate=14040.8kbits/s speed=1.19x",
    597.1,
  ),
  50,
  "ffmpeg's time= against the announced total",
);
assert.equal(
  percentOf("frame= 100 fps=60 time=00:00:01.00", 0),
  null,
  "no total yet: not progress, keep the line",
);
assert.equal(percentOf("frame= 100 fps=60 time=00:10:00.00", 597.1), 99, "never 100 before the rename");
assert.equal(percentOf("Exporting match 13171737 (Aquacorde vs Infume) with h264_vaapi...", 597.1), null);
console.log("exportRoutes: progress checks passed");
