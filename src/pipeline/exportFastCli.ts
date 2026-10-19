import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hookProblem } from "../shorts/videoPick.js";
import { requireArg } from "../cliArgs.js";
import { blockedIn, config, matchDir } from "../config.js";
import { getMatch, parseMatchId } from "../api/mcsrApi.js";
import { overlayPaths, readBannerStills, readSplitStills } from "./overlayRender.js";
import { exportStale, readSyncOffsets } from "./syncFile.js";
import {
  exportOutputPath,
  headTrimSec,
  readExportRecord,
  runFastExport,
  sliceStills,
  vaapiAvailable,
  writeExportRecord,
  type ExportRecord,
} from "./exportFast.js";
import { baseExportPath, chooseColdOpen, joinColdOpen, restoreColdOpen } from "./coldOpen.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { measureTail, suggestTailSec } from "./postRoll.js";

/**
 * npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]
 * npm run export:fast -- <matchId> --cold-open=<title hook>
 *
 * The headless path: renders the finished MP4 straight from the overlay artifacts, without melt
 * and without opening Kdenlive. `--cpu` forces libx264 when the VAAPI encode is unavailable or
 * its quality is not wanted.
 *
 * `--cold-open` (src/pipeline/coldOpen.ts) is the step the hooks' save runs before the long-form
 * uploads: it puts the cold open the export planned in front of `final-<id>.mp4`, with that hook
 * burned in — once; a different hook rebuilds it from the base, an empty one takes it out.
 */
const matchId = parseMatchId(requireArg("export:fast"));
/** Never cut closer than this to the finish; a hard cut on the dragon's death reads as broken. */
const MIN_TAIL_SEC = 15;
const forceCpu = process.argv.includes("--cpu");
/** Keep the whole configured post-roll instead of trimming to where the reaction stops. */
const fullTail = process.argv.includes("--full-tail");
/** Render only the first N seconds — a smoke test for the filter graph before a full run. */
const secondsArg = process.argv.slice(2).find((a) => a === "--seconds" || a.startsWith("--seconds="));
const limitSec = secondsArg === undefined ? NaN : Number(secondsArg.slice("--seconds=".length));
// A smoke run asked for in any spelling it cannot read refuses — falling through to a full export
// once wrote over a published match's final.
if (secondsArg !== undefined && !(limitSec > 0)) {
  console.error("export:fast: --seconds needs a positive number of seconds, written --seconds=N");
  process.exit(1);
}

const coldArg = process.argv.slice(2).find((a) => a.startsWith("--cold-open="));
const coldHook = coldArg === undefined ? undefined : coldArg.slice("--cold-open=".length).trim();

const match = await getMatch(matchId);
// A blocked runner withdrew their footage: never encoded, even from a render made before the
// block. Every caller (Export button, nightly chainExport, series) spawns this CLI.
if (blockedIn(match.players.map((p) => p.nickname))) {
  throw new Error(`match ${matchId} has a blocked player — it is not exported`);
}
const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) throw new Error(`Match ${matchId} does not have two players.`);

const outDir = matchDir(matchId);
const overlay = overlayPaths(outDir);
const splits = await readSplitStills(outDir);
const clipFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);

const missing = [
  [overlay.top, "top band"],
  [overlay.timer, "RTA timer"],
  [overlay.intro, "intro card"],
  [clipFor(playerLeft.nickname), `${playerLeft.nickname} POV`],
  [clipFor(playerRight.nickname), `${playerRight.nickname} POV`],
].filter(([file]) => !existsSync(file as string));
if (missing.length > 0 || splits === null) {
  throw new Error(
    `Match ${matchId} is not rendered yet — missing ${[...missing.map(([, what]) => what), ...(splits === null ? ["split stills"] : [])].join(", ")}. ` +
      `Run the pipeline for it first.`,
  );
}

const probe = async (file: string): Promise<number> => {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", reject);
    proc.on("close", () => resolve(parseFloat(out.trim())));
  });
};

const [leftDur, rightDur, timerDur, introDur] = await Promise.all([
  probe(clipFor(playerLeft.nickname)),
  probe(clipFor(playerRight.nickname)),
  probe(overlay.timer),
  // The card on disk, not config.introSec: a match rendered before the setting moved keeps its own.
  probe(overlay.intro),
]);

// The offsets the sync stage decided on, not the download estimate: without them the overlay
// runs seconds early and the two POVs sit apart by the difference between their two errors.
const sync = readSyncOffsets(outDir);
const leftStartSec = sync?.left ?? config.preRollSec;
const rightStartSec = sync?.right ?? config.preRollSec;
console.error(
  sync
    ? `Sync: match start ${leftStartSec.toFixed(2)}s / ${rightStartSec.toFixed(2)}s into the clips ` +
        `(sync.json, ${sync.source}, ${(sync.confidence * 100).toFixed(0)}%).`
    : `Sync: no sync.json — placing both clips at the coarse ${config.preRollSec}s estimate. ` +
        `npm run sync-status -- ${matchId} can derive it from the .kdenlive.`,
);

const clipInput = (nickname: string, durationSec: number, startSec: number) => ({
  path: clipFor(nickname),
  durationSec,
  matchOffsetIntoClipSec: startSec,
  clipName: `${nickname} POV`,
});

if (coldHook !== undefined) {
  await coldOpenStep(coldHook);
  process.exit(0);
}

/**
 * `--cold-open`: the planned window, encoded exactly as the export was and joined in front. Every
 * way out leaves `final-<id>.mp4` whole — joined with this hook, or the plain export.
 */
async function coldOpenStep(hook: string): Promise<void> {
  const record = readExportRecord(outDir, matchId);
  if (!record) throw new Error(`match ${matchId} has no export record — export it first`);
  if (record.coldOpenSec !== undefined && record.coldOpenHook === hook) {
    console.error(`Cold open: already in front with ${JSON.stringify(hook)} — nothing to do.`);
    return;
  }
  // A changed hook, or none: back to the plain export first, so nothing is ever stacked.
  const plain = restoreColdOpen(outDir, matchId)!;
  if (!plain.coldOpen || hook === "") {
    console.error(
      `Cold open: ${plain.coldOpen ? "no hook" : "none planned at export"} — the export goes as it is.`,
    );
    return;
  }
  // Every on-screen string carrying runner names goes through the hook checks (CLAUDE.md).
  const problem = hookProblem(hook, 100, match.players);
  if (problem) {
    console.error(`Cold open: the title hook is not burned in (${problem}) — the export goes as it is.`);
    return;
  }
  if (exportStale(outDir, exportOutputPath(outDir, matchId)).stale)
    throw new Error("sync.json changed after the export — re-export first, then the cold open is joined");
  const encoder = plain.encoder ?? "h264_vaapi";
  if (encoder === "h264_vaapi" && !vaapiAvailable())
    throw new Error("the export was encoded with h264_vaapi and the render node is gone");
  const { fromMs, sec } = plain.coldOpen;
  const fromSec = ANCHOR_SEC + fromMs / 1000;
  const segment = path.join(outDir, `coldopen-${matchId}.part.mp4`);
  const title = path.join(outDir, "overlay-coldopen-title.png");
  await renderBannerStill({ kind: "title", head: "", text: hook }, title);
  console.error(
    `Cold open: ${sec}s from ${(fromMs / 1000).toFixed(1)}s into the race, behind ${JSON.stringify(hook)}`,
  );
  try {
    await runFastExport(
      {
        leftClip: clipInput(playerLeft!.nickname, leftDur, leftStartSec),
        rightClip: clipInput(playerRight!.nickname, rightDur, rightStartSec),
        topPath: overlay.top,
        splits: sliceStills(splits!, fromSec, sec),
        timerPath: overlay.timer,
        introPath: overlay.intro,
        introOffsetSec: 0,
        windowFromSec: fromSec,
        overlays: [{ path: title, startSec: 0, endSec: sec }],
        fps: 60,
        totalDurationSec: sec,
        outPath: segment,
        useVaapi: encoder === "h264_vaapi",
        povAudioPan: config.povAudioPan,
        upscale1440: plain.upscale1440 === true,
      },
      (line) => process.stderr.write(`  ${line}\n`),
    );
    const joined = await joinColdOpen(outDir, matchId, segment, hook);
    console.error(
      `Cold open joined: match start now at ${joined.matchStartSec}s (${path.basename(baseExportPath(outDir, matchId))} kept until upload).`,
    );
  } finally {
    await rm(segment, { force: true });
  }
}

async function renderBannerStill(inputProps: { kind: "title"; head: string; text: string }, output: string) {
  const { renderStill, selectComposition } = await import("@remotion/renderer");
  const { bundleOnce } = await import("./remotionBundle.js");
  const serveUrl = await bundleOnce(() => {});
  await renderStill({
    composition: await selectComposition({ serveUrl, id: "Banner", inputProps }),
    serveUrl,
    output,
    imageFormat: "png",
    inputProps,
  });
}

// Where the run ends on the timeline: match start sits at ANCHOR_SEC by construction.
const runEndOnTimelineSec = ANCHOR_SEC + (match.result.time || 0) / 1000;
let totalDurationSec = timerDur;
if (!fullTail && match.result.time > 0 && timerDur > runEndOnTimelineSec + MIN_TAIL_SEC) {
  const maxTailSec = Math.min(config.postRollSec, timerDur - runEndOnTimelineSec);
  // Measured on the winner's POV — they are the one reacting.
  const winnerIsRight = match.result.uuid === playerRight.uuid;
  const winnerNickname = (winnerIsRight ? playerRight : playerLeft).nickname;
  // Into the winner's own clip, so the reaction is measured where it actually is.
  const runEndInClipSec = (winnerIsRight ? rightStartSec : leftStartSec) + (match.result.time || 0) / 1000;
  const tail = await measureTail(clipFor(winnerNickname), runEndInClipSec, maxTailSec);
  const tailSec = suggestTailSec(tail, { minSec: MIN_TAIL_SEC, maxSec: maxTailSec });
  totalDurationSec = runEndOnTimelineSec + tailSec;
  console.error(
    `Tail: keeping ${tailSec.toFixed(0)}s of ${maxTailSec.toFixed(0)}s after the run ` +
      `(${winnerNickname}'s reaction). --full-tail keeps all of it.`,
  );
}

// A card shorter than 7 s cuts the countdown's head so the card still opens the video and the
// countdown's last three seconds follow it: match start at introSec + 3 s. The card on disk decides.
const trimSec = headTrimSec(introDur);
const matchStartSec = ANCHOR_SEC - trimSec;
// The large COMING UP line over the countdown, from the card's end to match start (timeline
// seconds, before the trim). Only when the setting is on *and* the render drew one.
const teaserOn = config.countdownTeaser && existsSync(overlay.countdownTeaser);
// The retention opening's big lines, on the output's clock (match start at matchStartSec).
const overlays = (await readBannerStills(outDir)).map((b) => ({
  path: b.path,
  startSec: Math.max(0, matchStartSec + b.fromMs / 1000),
  endSec: matchStartSec + b.toMs / 1000,
}));

const useVaapi = !forceCpu && vaapiAvailable();
// A `--seconds` run is a smoke test and must not land on the finished MP4: it did once, and a
// published match's final-<id>.mp4 became a 20-second stub.
const outPath = Number.isFinite(limitSec)
  ? path.join(outDir, `smoke-${matchId}.mp4`)
  : exportOutputPath(outDir, matchId);
console.error(
  `Exporting match ${matchId} (${playerLeft.nickname} vs ${playerRight.nickname}) ` +
    `with ${useVaapi ? "h264_vaapi" : "libx264"}` +
    `${config.exportUpscale1440 ? " at 2560x1440 (exportUpscale1440)" : ""}...`,
);

const started = Date.now();
await runFastExport(
  {
    leftClip: clipInput(playerLeft.nickname, leftDur, leftStartSec),
    rightClip: clipInput(playerRight.nickname, rightDur, rightStartSec),
    topPath: overlay.top,
    // The winner's dot fills where the run ends; a ranked match has no second still.
    ...(existsSync(overlay.topEnd) && match.result.time > 0
      ? { topEndPath: overlay.topEnd, topEndAtSec: runEndOnTimelineSec }
      : {}),
    ...(teaserOn
      ? {
          countdownTeaserPath: overlay.countdownTeaser,
          countdownTeaserStartSec: trimSec + introDur,
          countdownTeaserEndSec: ANCHOR_SEC,
        }
      : {}),
    ...(trimSec > 0 ? { headTrimSec: trimSec } : {}),
    splits,
    timerPath: overlay.timer,
    introPath: overlay.intro,
    introOffsetSec: 0,
    ...(overlays.length > 0 ? { overlays } : {}),
    fps: 60,
    // The overlay spans lead-in + run + post-roll and starts at timeline 0, so it is the
    // timeline's length; a smoke run's N seconds are N seconds of output.
    totalDurationSec: Number.isFinite(limitSec) ? limitSec + trimSec : totalDurationSec,
    outPath,
    useVaapi,
    povAudioPan: config.povAudioPan,
    upscale1440: config.exportUpscale1440,
  },
  (line) => process.stderr.write(`  ${line}\n`),
);

// Beside the MP4, never for a smoke run: where match start sits in the finished video.
// The cold open is chosen now, under tonight's settings (an experiment arm), and joined when the
// hooks are saved; a fresh export has none in front yet, so a stale base goes with the old file.
if (!Number.isFinite(limitSec)) {
  const coldOpen = config.coldOpenSec === null ? null : chooseColdOpen(match, config.coldOpenSec);
  const record: ExportRecord = {
    matchStartSec,
    encoder: useVaapi ? "h264_vaapi" : "libx264",
    upscale1440: config.exportUpscale1440,
    ...(coldOpen ? { coldOpen } : {}),
  };
  writeExportRecord(outDir, matchId, record);
  await rm(baseExportPath(outDir, matchId), { force: true });
}

console.error(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s: ${outPath}`);
console.log(
  JSON.stringify({ matchId, outPath, anchorSec: ANCHOR_SEC, introSec: introDur, matchStartSec }, null, 2),
);
