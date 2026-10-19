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
  povAudioPan: 0.7,
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

// settb BEFORE setpts on every still chain. Reversed, the pts reads against the image demuxer's
// 1/25 default and framesync silently drops about half the frames downstream — no error, just a
// video missing 1594 of 3400 frames.
for (const chain of filter.split(";").filter((c) => /setpts=N\b/.test(c))) {
  const tb = chain.indexOf("settb=");
  const pts = chain.indexOf("setpts=");
  assert.ok(tb >= 0 && tb < pts, `settb must precede setpts in: ${chain}`);
}
// The frame number is the pts, never N/fps/TB: setpts truncates, 123/60*60 = 122.99999 → 122, and
// the repeated pts left the picture 1–3 frames behind the sound once the head trim counted frames.
assert.ok(!/setpts=N\/\d+\/TB/.test(filter), "frame-count setpts must not divide");

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
// Each POV toward its own side of the frame, both still audible in both ears.
assert.ok(
  filter.includes("[0:a]aformat=channel_layouts=stereo,pan=stereo|c0=0.70*c0+0.70*c1|c1=0.30*c0+0.30*c1[A0]"),
  "left POV leans left",
);
assert.ok(
  filter.includes("[1:a]aformat=channel_layouts=stereo,pan=stereo|c0=0.30*c0+0.30*c1|c1=0.70*c0+0.70*c1[A1]"),
  "right POV leans right",
);
assert.ok(filter.includes("[A0][A1]amix=inputs=2"), "and the two panned streams are what gets summed");

// A VOD that isn't 16:9 must be letterboxed, as qtblend distort=0 does — not stretched.
assert.ok(filter.includes("force_original_aspect_ratio=decrease"), "POVs must letterboxed, not stretched");
assert.ok(filter.includes("pad=960:540"), "and padded back to the pane size");

// A clip whose match start sits under ANCHOR_SEC into it starts that much later on the timeline,
// after black, exactly as the Kdenlive project's blank places it — not at the output's 0, ahead of
// the overlay and the other POV. Every clip with the usual headroom gets no pad at all.
{
  const early = { ...base, leftClip: { ...base.leftClip, matchOffsetIntoClipSec: 4 } };
  const e = buildFastExportCommand(early).args;
  const ef = e[e.indexOf("-filter_complex") + 1]!;
  assert.equal(e[e.indexOf("/m/left.mp4") - 2], "0.000", "nothing to seek past");
  assert.ok(
    /\[0:v\][^;]*fps=60,tpad=start_duration=6\.000:start_mode=add:color=black,settb=1\/60\[L\]/.test(ef),
    ef,
  );
  assert.ok(ef.includes("[0:a]adelay=6000:all=1,aformat=channel_layouts=stereo,"), ef);
  assert.ok(
    !/\[1:v\][^;]*tpad/.test(ef) && ef.includes("[1:a]aformat="),
    "the other POV is placed as before",
  );
  assert.ok(!filter.includes("tpad") && !filter.includes("adelay"), "the usual headroom pads nothing");
}

// The intro must be decoded with libvpx-vp9. ffmpeg's native vp9 decoder drops the alpha
// side-data, which turns the fades back into hard cuts — silently, and visible only by looking
// at a frame mid-fade.
const introIndex = args.indexOf("/m/overlay-intro.webm");
assert.equal(args[introIndex - 1], "-i");
assert.equal(args[introIndex - 2], "libvpx-vp9");
assert.equal(args[introIndex - 3], "-c:v");

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

// A playoff game's top band is two stills switched at the run's end: the winner's dot fills
// there and nowhere else. The second still is the last input, after the splits.
{
  const two = buildFastExportCommand({ ...base, topEndPath: "/m/overlay-top-end.png", topEndAtSec: 45.5 });
  const f = two.args[two.args.indexOf("-filter_complex") + 1]!;
  const endIndex = two.args.indexOf("/m/overlay-top-end.png");
  assert.ok(endIndex > two.args.indexOf("/m/overlay-splits-1.png"), "the end still is the last input");
  const inputNo = two.args.slice(0, endIndex).filter((a) => a === "-i").length - 1;
  assert.ok(
    f.includes(`[2:v]scale=1920:194:flags=bilinear,format=yuv420p,setsar=1,loop=loop=${45.5 * 60 - 1}`),
  );
  assert.ok(
    f.includes(
      `[${inputNo}:v]scale=1920:194:flags=bilinear,format=yuv420p,setsar=1,loop=loop=${(70 - 45.5) * 60 - 1}`,
    ),
  );
  assert.ok(f.includes("[T0][T1]concat=n=2:v=1:a=0,settb=1/60[TOP]"));
  // The switch past the end, or at zero, is one still — nothing to concat.
  const late = buildFastExportCommand({ ...base, topEndPath: "/m/overlay-top-end.png", topEndAtSec: 90 });
  assert.ok(!late.args[late.args.indexOf("-filter_complex") + 1]!.includes("[T1]"));
  assert.ok(!filter.includes("[T1]"), "a ranked match's band is the one still it always was");
}

// --- The head trim and the countdown teaser (24 Sept 2026) --------------------------------------
{
  const { headTrimSec, exportMatchStartSec, writeExportRecord } = await import("./exportFast.js");
  const { ANCHOR_SEC } = await import("./kdenliveProject.js");
  // Match start in the finished video is introSec + 3: the card, then "3, 2, 1".
  assert.equal(ANCHOR_SEC - headTrimSec(7), 10, "a 7 s card keeps match start at 0:10");
  assert.equal(ANCHOR_SEC - headTrimSec(3), 6);
  assert.equal(ANCHOR_SEC - headTrimSec(2), 5);
  assert.equal(headTrimSec(3.017), 4, "a probed card length is rounded to tenths");
  assert.equal(headTrimSec(7.017), 0, "never negative");
  assert.equal(headTrimSec(NaN), 0, "an unreadable card length cuts nothing");

  // Off (no trim, no teaser, or a teaser with no window) is today's command, byte for byte.
  const today = buildFastExportCommand(base).args;
  for (const off of [
    { headTrimSec: 0 },
    { countdownTeaserPath: "/m/ct.png" },
    { countdownTeaserPath: "/m/ct.png", countdownTeaserStartSec: 7, countdownTeaserEndSec: 7 },
  ])
    assert.deepEqual(buildFastExportCommand({ ...base, ...off }).args, today, JSON.stringify(off));

  // A 3 s card: the stage and the audio both lose the first 4 s, the card lies over the output's
  // own 0, and the output is 4 s shorter than the timeline.
  const trimmed = buildFastExportCommand({ ...base, headTrimSec: 4 }).args;
  const tf = trimmed[trimmed.indexOf("-filter_complex") + 1]!;
  assert.ok(tf.includes("[STAGE]trim=start_frame=240,setpts=PTS-STARTPTS[STAGET]"), tf);
  assert.ok(tf.includes("[STAGET][INTRO]overlay="), "the card over the trimmed stage");
  assert.ok(tf.includes(",atrim=start=4.000000,asetpts=PTS-STARTPTS[A]"), "the audio trimmed with it");
  assert.equal(trimmed[trimmed.indexOf("-t") + 1], "66.000");
  assert.equal(seekBefore("/m/left.mp4"), left.inSec.toFixed(3), "the clips are placed as before");

  // The teaser: one more input after the stills, over timeline 7..10, before the trim.
  const teased = buildFastExportCommand({
    ...base,
    headTrimSec: 4,
    countdownTeaserPath: "/m/ct.png",
    countdownTeaserStartSec: 7,
    countdownTeaserEndSec: 10,
  }).args;
  const cf = teased[teased.indexOf("-filter_complex") + 1]!;
  const ctIndex = teased.filter((a) => a === "-i").length - 1;
  assert.equal(teased[teased.lastIndexOf("-i") + 1], "/m/ct.png");
  assert.ok(cf.includes(`[${ctIndex}:v]scale=1920:1080`), cf);
  assert.ok(cf.includes("loop=loop=179:size=1:start=0,settb=1/60,setpts=N+420[CT]"), cf);
  assert.ok(cf.includes("[STAGE][CT]overlay=0:0:format=yuv420:eof_action=pass:repeatlast=0[STAGEC]"));
  assert.ok(cf.includes("[STAGEC]trim=start_frame=240"), "teaser first, on timeline seconds");

  // The record: absent is 0:10 (every export before this), present is what export:fast wrote.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "export-record-"));
  assert.equal(exportMatchStartSec(dir, 1), 10);
  writeExportRecord(dir, 1, { matchStartSec: 6 });
  assert.equal(exportMatchStartSec(dir, 1), 6);
  writeFileSync(path.join(dir, "final-2.json"), "{ broken");
  assert.equal(exportMatchStartSec(dir, 2), 10, "an unreadable record is the default");
}

// --- exportUpscale1440 (7 Oct 2026) --------------------------------------------------------
{
  // Off (absent, same as every export before this) is today's command, byte for byte.
  assert.deepEqual(buildFastExportCommand({ ...base, upscale1440: false }).args, args);

  // On: the composited 1080p frame is scaled up once, after the intro overlay, nothing before
  // it changes, and the quality setting softens so the file does not nearly double.
  const up = buildFastExportCommand({ ...base, upscale1440: true });
  const uf = up.args[up.args.indexOf("-filter_complex") + 1]!;
  assert.ok(
    /overlay=0:0:format=yuv420:eof_action=pass:repeatlast=0\[STAGEI\]/.test(uf),
    "overlay lands on an intermediate label when a post-step follows",
  );
  assert.ok(
    uf.includes("[STAGEI]scale=2560:1440:flags=lanczos[V]"),
    "the upscale is the one post-overlay step on the CPU path",
  );
  assert.equal(
    (uf.match(/scale=2560:1440/g) ?? []).length,
    1,
    "every overlay asset stays 1080p; only the final frame is scaled",
  );
  assert.ok(up.args.includes("libx264"));
  assert.ok(up.args.includes("23"), "crf softened from 21 to 23 so the upscale does not ~double the file");
  assert.ok(!up.args.includes("21"), "the base crf must not also be present");

  // On top of VAAPI: overlay -> scale (still CPU) -> format/hwupload -> the encoder.
  const upGpu = buildFastExportCommand({ ...base, upscale1440: true, useVaapi: true });
  const ugf = upGpu.args[upGpu.args.indexOf("-filter_complex") + 1]!;
  assert.ok(ugf.includes("[STAGEI]scale=2560:1440:flags=lanczos[STAGEU]"));
  assert.ok(ugf.includes("[STAGEU]format=nv12,hwupload[V]"));
  assert.ok(upGpu.args.includes("25"), "qp softened from 23 to 25 to match");
  assert.ok(!upGpu.args.includes("23"), "the base qp must not also be present");

  // VAAPI alone (no upscale) is unchanged: overlay -> format/hwupload directly.
  const gpuOnly = buildFastExportCommand({ ...base, useVaapi: true });
  const gof = gpuOnly.args[gpuOnly.args.indexOf("-filter_complex") + 1]!;
  assert.ok(gof.includes("overlay=0:0:format=yuv420:eof_action=pass:repeatlast=0[STAGEI]"));
  assert.ok(gof.includes("[STAGEI]format=nv12,hwupload[V]"));
  assert.ok(!gof.includes("scale=2560:1440"));
}

{
  // A blocked runner's match is never encoded. The Export button, the nightly's chainExport and the
  // series all spawn this CLI, so the refusal lives in it — before any probe, encode or write.
  const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const tmp = mkdtempSync(path.join(tmpdir(), "export-blocked-"));
  const id = 990001;
  const match = JSON.parse(readFileSync(path.join(root, "src/fixtures/match-13446429.json"), "utf8"));
  match.id = id;
  match.players[0].nickname = "Aquacorde";
  // The MCSR API answers from the fixture; anything else is a test failure, not a network call.
  writeFileSync(
    path.join(tmp, "stub.mjs"),
    `const body = ${JSON.stringify(JSON.stringify({ status: "success", data: match }))};\n` +
      `globalThis.fetch = async (url) => { if (String(url).includes("/matches/${id}")) return new Response(body); throw new Error("no network: " + url); };\n`,
  );
  writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ mediaDir: tmp, blockedPlayers: ["Aquacorde"] }),
  );
  const cli = spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [
      "--import",
      path.join(tmp, "stub.mjs"),
      path.join(root, "src/pipeline/exportFastCli.ts"),
      String(id),
      "--cpu",
      "--seconds=1",
    ],
    {
      env: { ...process.env, MCSR_CONFIG: path.join(tmp, "config.json"), MCSR_ARCHIVE_DIR: tmp },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.notEqual(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /blocked player/);
  assert.ok(!existsSync(path.join(tmp, String(id), `smoke-${id}.mp4`)), "nothing encoded");
  rmSync(tmp, { recursive: true, force: true });
}

// Timed overlays (src/pipeline/banners.ts) go over the finished frame after the intro card and
// before the upscale, each on the output's clock; none leaves the graph as it was.
{
  const off = buildFastExportCommand(base).args;
  const on = buildFastExportCommand({
    ...base,
    upscale1440: true,
    overlays: [
      { path: "/m/overlay-banner-0.png", startSec: 0, endSec: 5 },
      { path: "/m/overlay-banner-1.png", startSec: 20, endSec: 26 },
    ],
  }).args;
  const f = on[on.indexOf("-filter_complex") + 1]!;
  assert.ok(f.includes("eof_action=pass:repeatlast=0[STAGEI];"), "the intro first");
  assert.ok(f.includes("setpts=N+1200[O1]"), "the second banner starts at 20 s of output");
  assert.ok(f.includes("loop=loop=359:size=1"), "and holds for its 6 s");
  assert.ok(f.includes("[STAGEI][O0]overlay") && f.includes("[STAGEO0][O1]overlay"), "chained in order");
  assert.ok(f.includes("[STAGEO1]scale=2560:1440:flags=lanczos[V]"), "then the upscale");
  assert.deepEqual(
    buildFastExportCommand({ ...base, overlays: [] }).args,
    off,
    "an empty list changes nothing",
  );
}

// The cold open's window: the clips and the timer seeked to it, no intro card, a fade at each end.
{
  const w = buildFastExportCommand({
    ...base,
    splits: [{ path: "/m/overlay-splits-3.png", startSec: 0, durationSec: 5 }],
    windowFromSec: 312.5,
    totalDurationSec: 5,
    overlays: [{ path: "/m/title.png", startSec: 0, endSec: 5 }],
  }).args;
  const wf = w[w.indexOf("-filter_complex") + 1]!;
  assert.equal(w[w.indexOf("/m/left.mp4") - 2], (left.inSec + 312.5).toFixed(3));
  assert.equal(w[w.indexOf("/m/overlay-timer.mp4") - 2], "312.500");
  assert.ok(!wf.includes("[INTRO]"), "no intro card mid-race");
  assert.ok(wf.includes("[STAGE][O0]overlay"), "the title straight over the stage");
  assert.ok(wf.includes("afade=t=in:d=0.08,afade=t=out:st=4.750:d=0.25[A]"));
  assert.equal(w[w.indexOf("-t") + 1], "5.000");
}

console.log("exportFast: all checks passed");
