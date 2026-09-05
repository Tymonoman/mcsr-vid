import assert from "node:assert/strict";
import { buildFastExportCommand } from "./exportFast.js";
import { placeOnTimeline } from "./kdenliveProject.js";

const base = {
  leftClip: { path: "/m/left.mp4", durationSec: 700, matchOffsetIntoClipSec: 150, clipName: "L" },
  rightClip: { path: "/m/right.mp4", durationSec: 700, matchOffsetIntoClipSec: 147.3, clipName: "R" },
  topPath: "/m/overlay-top.png",
  splits: [
    { path: "/m/overlay-splits-0.png", startSec: 0, durationSec: 30 },
    { path: "/m/overlay-splits-1.png", startSec: 30, durationSec: 40 },
  ],
  timerPath: "/m/overlay-timer.mp4",
  introPath: "/m/overlay-intro.webm",
  introOffsetSec: 0,
  fps: 60,
  totalDurationSec: 70,
  outPath: "/m/final.mp4",
};

const { args } = buildFastExportCommand(base);
const filter = args[args.indexOf("-filter_complex") + 1]!;

// The two paths must place clips identically, or the Kdenlive export and the headless export
// are different videos. Both go through placeOnTimeline; check the -ss actually carries it.
const left = placeOnTimeline(base.leftClip);
const right = placeOnTimeline(base.rightClip);
// ["-ss", "<value>", "-i", "<path>"], so the seek value sits two before the path.
const seekBefore = (file: string) => args[args.indexOf(file) - 2];
assert.equal(seekBefore("/m/left.mp4"), left.inSec.toFixed(3));
assert.equal(seekBefore("/m/right.mp4"), right.inSec.toFixed(3));
assert.equal(left.inSec, 140, "150s offset minus the 10s anchor");
assert.ok(Math.abs(right.inSec - 137.3) < 1e-9);

// settb BEFORE setpts on every still chain. Reversed, `TB` resolves against the image demuxer's
// 1/25 default and framesync silently drops about half the frames downstream — no error, just a
// video missing 1594 of 3400 frames.
for (const chain of filter.split(";").filter((c) => c.includes("setpts=N/"))) {
  const tb = chain.indexOf("settb=");
  const pts = chain.indexOf("setpts=");
  assert.ok(tb >= 0 && tb < pts, `settb must precede setpts in: ${chain}`);
}

// Stills are decoded once and looped, not decoded per frame. Decoding them per frame measured
// more CPU than both 1080p60 POV decodes put together.
for (const [i, still] of base.splits.entries()) {
  const frames = Math.round(still.durationSec * base.fps);
  assert.ok(
    filter.includes(`loop=loop=${frames - 1}:size=1:start=0`),
    `split ${i} (${still.path}) must be looped from one decoded frame`,
  );
}
assert.ok(filter.includes(`loop=loop=${70 * 60 - 1}:size=1:start=0`), "the top band is looped too");

// The layers tile the frame, so only the intro is alpha-composited; everything else stacks.
assert.equal((filter.match(/overlay=/g) ?? []).length, 1, "only the intro may be an alpha overlay");
assert.ok(filter.includes("hstack=inputs=2"), "the POVs and the bottom band stack side by side");
assert.ok(filter.includes("vstack=inputs=3"), "top band, POVs and bottom band stack vertically");
assert.ok(filter.includes("eof_action=pass"), "the stage must continue after the intro ends");
assert.ok(filter.includes("repeatlast=0"), "the intro's last frame must not be held over the match");

// MLT's mix transition sums its inputs (sum=1); ffmpeg's amix halves each by default, which
// would put the headless export 6dB below the Kdenlive one.
assert.ok(filter.includes("normalize=0"), "audio must be summed, not averaged");

// A VOD that isn't 16:9 must be letterboxed, as qtblend distort=0 does — not stretched.
assert.ok(filter.includes("force_original_aspect_ratio=decrease"), "POVs must letterboxed, not stretched");
assert.ok(filter.includes("pad=960:540"), "and padded back to the pane size");

// Encoder selection, and the promote-on-success name.
assert.ok(args.includes("libx264"), "CPU path by default in this fixture");
const gpu = buildFastExportCommand({ ...base, useVaapi: true });
assert.ok(gpu.args.includes("h264_vaapi"));
assert.ok(gpu.args.includes("-init_hw_device"), "the hw device must be initialised for VAAPI");
assert.ok(
  gpu.args[gpu.args.indexOf("-filter_complex") + 1]!.includes("hwupload"),
  "frames must be uploaded before a VAAPI encode",
);

// A clip whose match start exceeds its own length is refused rather than silently emptied.
assert.throws(
  () => buildFastExportCommand({ ...base, leftClip: { ...base.leftClip, durationSec: 100 } }),
  /trim the whole clip away/,
);

console.log("exportFast: all checks passed");
