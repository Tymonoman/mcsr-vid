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
import { ANCHOR_SEC } from "./pipeline/kdenliveProject.js";
import { frameMotion } from "./pipeline/countdownDetect.js";
import { overlayPaths, readSplitStills, type SplitStill } from "./pipeline/overlayRender.js";
import { runFastExport, vaapiAvailable } from "./pipeline/exportFast.js";
import { readSyncOffsets, type SyncOffsets } from "./pipeline/syncFile.js";
import { listProcessedMatchIds } from "./dashboard/matchStatus.js";
import { getMatch } from "./api/mcsrApi.js";
import { POV_WIDTH, STAGE_HEIGHT, STAGE_WIDTH, TOP_BAND_HEIGHT } from "../remotion/layout.js";

const FPS = 60;
/** Long enough to cover the intro (0-7s), the rest of the countdown, and gameplay past the anchor. */
const RENDER_SEC = 14;
/** Where in the intro to look: this far before the card on disk ends (config.introSec, 2-7 s), not a
 *  fixed 6.85 s past a short card. The versus screen's halves are parting there, so the card is solid
 *  on the outside and see-through between at once; at a hold frame it is opaque and says nothing. */
const EXIT_PROBE_BEFORE_END_SEC = 0.15;
/** Mean error (0-255 per channel) under which the export is the card blended over the footage:
 *  codec noise, 1.5-2.4 on eight real matches. The same export with the card painted opaque is 14-19 off. */
const BLEND_ERR_MAX = 5;

const skip = (why: string) => {
  console.log(`exportFrames: skipped — ${why}`);
  process.exit(0);
};

// Whichever match on this box has a rendered overlay and both POV clips, rather than a pinned
// id: the fixtures are whatever the lab last rendered, and the desktop has none.
// A ranked match that still has its own export first: a playoff game's countdown is not frozen
// (the player can look around) and a joined series' game 1 carries a static stream panel, and the
// clips of older uploads get deleted to free disk.
const processed = [...listProcessedMatchIds()].sort((a, b) => {
  const rank = (id: number) => {
    const dir = path.join(config.mediaDir, String(id));
    const series = existsSync(path.join(dir, "series.json")) ? 2 : 0;
    const noFinal = existsSync(path.join(dir, `final-${id}.mp4`)) ? 0 : 1;
    return series + noFinal;
  };
  return rank(a) - rank(b) || b - a;
});
if (processed.length === 0) skip("no media at all (fixtures are 1.4 GB of VODs, not committed)");
let outDir = "";
let splits: SplitStill[] | null = null;
let sync: SyncOffsets | null = null;
let playerLeft: { nickname: string } | undefined;
let playerRight: { nickname: string } | undefined;
const clipFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);
for (const id of processed) {
  outDir = path.join(config.mediaDir, String(id));
  splits = await readSplitStills(outDir);
  if (splits === null) continue;
  // Where match start falls in each clip is the countdown detector's reading, not a hand-set one
  // or the download estimate: 2. below takes the export's placement for true, and a hand-set sync
  // put one match's overlay timer 6.5 s behind the players' own (13672776).
  sync = readSyncOffsets(outDir);
  if (sync?.source !== "countdown") continue;
  const match = await getMatch(id).catch(() => null);
  if (match === null) skip("the MCSR API is unreachable, so the POV clips cannot be identified");
  [playerLeft, playerRight] = match!.players;
  if (
    playerLeft &&
    playerRight &&
    existsSync(clipFor(playerLeft.nickname)) &&
    existsSync(clipFor(playerRight.nickname))
  ) {
    console.log(`exportFrames: using match ${id} (${playerLeft.nickname} vs ${playerRight.nickname})`);
    break;
  }
  playerLeft = playerRight = undefined;
}
if (!playerLeft || !playerRight || !sync)
  skip(
    "no match has a rendered overlay, a detected sync and both POV clips — run the pipeline for one first",
  );
const overlay = overlayPaths(outDir);

/**
 * Raw stage-sized frames of `file` from `atSec`, as many as `limit` (ffmpeg output options)
 * lets through: RGB triples, or RGBA when the file's alpha plane is wanted. One frame per decoded
 * frame, so a window of the 30 fps card is not padded to the timeline's 60.
 */
function stageFrames(
  file: string,
  atSec: number,
  limit: string[],
  opts: { alpha?: boolean; decoder?: string } = {},
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error"];
    if (opts.decoder) args.push("-c:v", opts.decoder);
    args.push("-ss", String(atSec), "-i", file, ...limit, "-fps_mode", "passthrough");
    args.push("-f", "rawvideo", "-pix_fmt", opts.alpha ? "rgba" : "rgb24", "-");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(-300)));
      const buf = Buffer.concat(chunks);
      const size = STAGE_WIDTH * STAGE_HEIGHT * (opts.alpha ? 4 : 3);
      const frames: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size)
        frames.push(new Uint8Array(buf.subarray(i, i + size)));
      resolve(frames);
    });
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

  const [leftDur, rightDur, introDur] = await Promise.all([
    probeDuration(clipFor(playerLeft!.nickname)),
    probeDuration(clipFor(playerRight!.nickname)),
    probeDuration(overlay.intro),
  ]);
  const probeSec = introDur - EXIT_PROBE_BEFORE_END_SEC;

  // The clips are placed where the sync stage found match start, as `export:fast` places them: the
  // download estimate (config.preRollSec) is seconds off a real match — 3 s on doogile vs BeefSalad,
  // which starts one POV moving before the anchor and fails 2. below for nothing the export did.
  await runFastExport({
    leftClip: {
      path: clipFor(playerLeft!.nickname),
      durationSec: leftDur,
      matchOffsetIntoClipSec: sync!.left,
      clipName: "L",
    },
    rightClip: {
      path: clipFor(playerRight!.nickname),
      durationSec: rightDur,
      matchOffsetIntoClipSec: sync!.right,
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
  // native vp9 decoder, both of which have done it — the card is painted opaque: black between
  // its halves, the VS at full strength, no gameplay. One frame of the card's exit is compared,
  // all of it, with two models of what the export should show: the card blended over the footage
  // by its own alpha, and the card painted opaque. Where the card is solid the two models are
  // the same pixel, so a single pixel cannot tell them apart — and the one this test used to
  // read sat inside the left half. Decoding the card with libvpx-vp9 is deliberate: the native
  // decoder would report no alpha and make this test agree with a broken export. The footage
  // under the card is the export once the card is gone: both POVs are frozen through the
  // countdown (2. below).
  const [composited] = await stageFrames(out, probeSec, ["-frames:v", "1"]);
  const [footage] = await stageFrames(out, introDur + 0.2, ["-frames:v", "1"]);
  // Which of the card's frames the 60 fps timeline shows at that instant is for the filter graph
  // to say (the card has 30), and a neighbour is 100 px away: the one that fits best is the one.
  const cards = await stageFrames(overlay.intro, probeSec - 0.15, ["-t", "0.2"], {
    alpha: true,
    decoder: "libvpx-vp9",
  });
  assert.ok(composited && footage && cards.length > 0, "could not read the frames to compare");
  const channels = STAGE_WIDTH * STAGE_HEIGHT * 3;
  let blended = Infinity;
  let painted = 0;
  for (const card of cards) {
    let blend = 0;
    let paint = 0;
    for (let p = 0; p < STAGE_WIDTH * STAGE_HEIGHT; p++) {
      const alpha = card[p * 4 + 3]! / 255;
      for (let c = 0; c < 3; c++) {
        const seen = composited[p * 3 + c]!;
        const own = card[p * 4 + c]!;
        blend += Math.abs(seen - (alpha * own + (1 - alpha) * footage[p * 3 + c]!));
        paint += Math.abs(seen - own);
      }
    }
    if (blend / channels < blended) [blended, painted] = [blend / channels, paint / channels];
  }
  const probeAt = `${probeSec.toFixed(2)} s`;
  assert.ok(
    blended < BLEND_ERR_MAX,
    `the intro is not being blended: at ${probeAt} the export is ${blended.toFixed(1)} off the card laid ` +
      `over the footage and ${painted.toFixed(1)} off the card painted opaque — alpha was dropped ` +
      `somewhere in the chain, or the card is missing or misplaced`,
  );
  assert.ok(
    painted > 2 * BLEND_ERR_MAX,
    `${probeAt} cannot tell a blended intro from an opaque one: painted opaque, the card would be only ` +
      `${painted.toFixed(1)} off what the export shows. The card is solid there, or the footage under it ` +
      `black — move EXIT_PROBE_BEFORE_END_SEC to where the card is part see-through`,
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
    `exportFrames: intro blends (${blended.toFixed(1)} off the blend, ${painted.toFixed(1)} off an opaque ` +
      `card), both POVs freeze then move at ${ANCHOR_SEC}s, RTA runs only after it, top band static`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
