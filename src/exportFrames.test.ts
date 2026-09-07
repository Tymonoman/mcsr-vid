/**
 * Renders a few seconds of the real export and checks the frames.
 *
 * Every bug this pins rendered *perfectly*. The intro composited as a solid card for months
 * because ProRes alpha is dropped by MLT and then, one layer down, by ffmpeg's native vp9
 * decoder; the only way anyone noticed was looking at a frame mid-fade. The unit tests cannot
 * see any of it — they check the pieces, and these are properties of the pieces composited
 * together.
 *
 * Assertions are on *properties*, not on committed golden PNGs. h264_vaapi is not bit
 * reproducible, so a golden would fail on encoder or driver changes while still passing on a
 * genuinely broken composite — the opposite of what a regression test should do. Each assertion
 * below names a way the video is wrong, not a way it differs.
 *
 * Skips cleanly when the match media is absent: the fixtures are 1.4 GB of VODs that cannot be
 * committed, so on any machine without them this must be a no-op rather than a failure.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { frameMotion } from "./countdownDetect.js";
import { overlayPaths, readSplitStills } from "./overlayRender.js";
import { runFastExport, vaapiAvailable } from "./exportFast.js";
import { getMatch } from "./mcsrApi.js";
import { POV_WIDTH, STAGE_HEIGHT, STAGE_WIDTH, TOP_BAND_HEIGHT } from "../remotion/layout.js";

const MATCH_ID = 12296170;
const FPS = 60;
/** Long enough to cover the intro (0-7s), the rest of the countdown, and gameplay past the anchor. */
const RENDER_SEC = 14;
/** Deep in the intro's 0.6s wipe-out, where the card is ~11% opaque over live gameplay. */
const FADE_PROBE_SEC = 6.85;
/** A point inside the left POV pane, below the top band. */
const PROBE_X = 300;
const PROBE_Y = 300;

const skip = (why: string) => {
  console.log(`exportFrames: skipped — ${why}`);
  process.exit(0);
};

const outDir = path.join(config.mediaDir, String(MATCH_ID));
const overlay = overlayPaths(outDir);
if (!existsSync(outDir)) skip(`no media for match ${MATCH_ID} (fixtures are 1.4 GB of VODs, not committed)`);
const splits = await readSplitStills(outDir);
if (splits === null) skip(`match ${MATCH_ID} has no rendered overlay — run the pipeline for it first`);

const match = await getMatch(MATCH_ID).catch(() => null);
if (match === null) skip("the MCSR API is unreachable, so the POV clips cannot be identified");
const [playerLeft, playerRight] = match!.players;
const clipFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);
for (const p of [playerLeft, playerRight]) {
  if (!p || !existsSync(clipFor(p.nickname))) skip(`missing POV clip for ${p?.nickname ?? "a player"}`);
}

/** Raw pixels of one frame at a timestamp, as RGB triples. */
function framePixels(file: string, atSec: number, decoder?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error"];
    if (decoder) args.push("-c:v", decoder);
    args.push("-ss", String(atSec), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(err.slice(-300))),
    );
  });
}

/** Downscaled grayscale frames of one region, for measuring whether it moves. */
function regionMotion(file: string, crop: string, startSec: number, durationSec: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(startSec),
        "-t",
        String(durationSec),
        "-i",
        file,
        "-vf",
        `${crop},fps=10,scale=64:36,format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(-300)));
      const buf = Buffer.concat(chunks);
      const size = 64 * 36;
      const frames: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size)
        frames.push(new Uint8Array(buf.subarray(i, i + size)));
      resolve(frameMotion(frames));
    });
  });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-frames-"));
const out = path.join(dir, "probe.mp4");
try {
  const probeDuration = async (file: string) =>
    Number(
      (
        await new Promise<string>((resolve, reject) => {
          const p = spawn(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              file,
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
          );
          let o = "";
          p.stdout.on("data", (d) => (o += d));
          p.on("error", reject);
          p.on("close", () => resolve(o));
        })
      ).trim(),
    );

  const [leftDur, rightDur] = await Promise.all([
    probeDuration(clipFor(playerLeft!.nickname)),
    probeDuration(clipFor(playerRight!.nickname)),
  ]);

  await runFastExport({
    leftClip: {
      path: clipFor(playerLeft!.nickname),
      durationSec: leftDur,
      matchOffsetIntoClipSec: config.preRollSec,
      clipName: "L",
    },
    rightClip: {
      path: clipFor(playerRight!.nickname),
      durationSec: rightDur,
      matchOffsetIntoClipSec: config.preRollSec,
      clipName: "R",
    },
    topPath: overlay.top,
    splits: splits!,
    timerPath: overlay.timer,
    introPath: overlay.intro,
    introOffsetSec: 0,
    fps: FPS,
    totalDurationSec: RENDER_SEC,
    outPath: out,
    useVaapi: vaapiAvailable(),
  });

  // --- 1. The intro alpha-composites, rather than painting over the gameplay ------------------
  // THE regression. If alpha is dropped anywhere in the chain — MLT's qtblend, or ffmpeg's
  // native vp9 decoder, both of which have done it — the composited pixel IS the card's own
  // colour. Decoding the card with libvpx-vp9 is deliberate: the native decoder would report no
  // alpha and make this test agree with a broken export.
  const composited = await framePixels(out, FADE_PROBE_SEC);
  const card = await framePixels(overlay.intro, FADE_PROBE_SEC, "libvpx-vp9");
  const at = (px: Uint8Array, w: number) => {
    const i = (PROBE_Y * w + PROBE_X) * 3;
    return [px[i]!, px[i + 1]!, px[i + 2]!] as const;
  };
  const [cr, cg, cb] = at(composited, STAGE_WIDTH);
  const [ir, ig, ib] = at(card, STAGE_WIDTH);
  const delta = Math.max(Math.abs(cr - ir), Math.abs(cg - ig), Math.abs(cb - ib));
  assert.ok(
    delta > 25,
    `the intro is not being blended: composited (${cr},${cg},${cb}) is the card's own colour ` +
      `(${ir},${ig},${ib}) — alpha was dropped somewhere in the chain`,
  );

  // --- 2. Both POVs are frozen through the countdown and move after it -----------------------
  // Match start lands at ANCHOR_SEC by construction, and MCSR locks both players until then. If
  // sync drifted, or the anchor moved, one half starts moving at the wrong time.
  const halves = {
    left: `crop=${POV_WIDTH}:${STAGE_HEIGHT - TOP_BAND_HEIGHT}:0:${TOP_BAND_HEIGHT}`,
    right: `crop=${POV_WIDTH}:${STAGE_HEIGHT - TOP_BAND_HEIGHT}:${POV_WIDTH}:${TOP_BAND_HEIGHT}`,
  };
  for (const [side, crop] of Object.entries(halves)) {
    // Start at 7s so the opaque intro is out of the way; stop 0.5s short of the anchor.
    const frozen = await regionMotion(out, crop, 7, ANCHOR_SEC - 7.5);
    const moving = await regionMotion(out, crop, ANCHOR_SEC + 0.5, RENDER_SEC - ANCHOR_SEC - 1);
    assert.ok(
      median(frozen) < 2,
      `${side} POV is moving during the countdown (median ${median(frozen).toFixed(1)}) — the ` +
        `anchor or that clip's sync offset is wrong`,
    );
    assert.ok(
      median(moving) > 4 * Math.max(median(frozen), 0.5),
      `${side} POV is not moving after match start (frozen ${median(frozen).toFixed(1)} vs ` +
        `moving ${median(moving).toFixed(1)}) — gameplay is not where the anchor says it is`,
    );
  }

  // --- 3. The RTA timer runs, and only after match start --------------------------------------
  // It is clamped to 0:00.000 until timerStartFrame, so a timer ticking during the countdown
  // means the overlay's lead-in disagrees with the timeline's anchor.
  const rtaCrop = `crop=480:346:1440:${STAGE_HEIGHT - 346}`;
  const rtaBefore = await regionMotion(out, rtaCrop, 7, ANCHOR_SEC - 7.5);
  const rtaAfter = await regionMotion(out, rtaCrop, ANCHOR_SEC + 0.5, RENDER_SEC - ANCHOR_SEC - 1);
  assert.ok(
    median(rtaBefore) < 1,
    `the RTA timer is running before match start (${median(rtaBefore).toFixed(2)})`,
  );
  assert.ok(
    median(rtaAfter) > 0.5,
    `the RTA timer is not running after match start (${median(rtaAfter).toFixed(2)})`,
  );

  // --- 4. The top band is a still, held for the whole clip ------------------------------------
  // It is one PNG on the timeline; any motion means it is being re-decoded or has drifted.
  const topMotion = await regionMotion(
    out,
    `crop=${STAGE_WIDTH}:${TOP_BAND_HEIGHT}:0:0`,
    7.5,
    RENDER_SEC - 8,
  );
  assert.ok(median(topMotion) < 1, `the top band is not static (${median(topMotion).toFixed(2)})`);

  console.log(
    `exportFrames: intro blends (delta ${delta}), both POVs freeze then move at ${ANCHOR_SEC}s, ` +
      `RTA runs only after it, top band static`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
