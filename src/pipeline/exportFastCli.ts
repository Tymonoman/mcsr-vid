import path from "node:path";
import { existsSync } from "node:fs";
import { requireArg } from "../cliArgs.js";
import { config, matchDir } from "../config.js";
import { getMatch, parseMatchId } from "../api/mcsrApi.js";
import { overlayPaths, readSplitStills } from "./overlayRender.js";
import { readSyncOffsets } from "./syncFile.js";
import { exportOutputPath, runFastExport, vaapiAvailable } from "./exportFast.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { measureTail, suggestTailSec } from "./postRoll.js";

/**
 * npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]
 *
 * The headless path: renders the finished MP4 straight from the overlay artifacts, without melt
 * and without opening Kdenlive. `--cpu` forces libx264 when the VAAPI encode is unavailable or
 * its quality is not wanted.
 */
const matchId = parseMatchId(requireArg("export:fast"));
/** Never cut closer than this to the finish; a hard cut on the dragon's death reads as broken. */
const MIN_TAIL_SEC = 15;
const forceCpu = process.argv.includes("--cpu");
/** Keep the whole configured post-roll instead of trimming to where the reaction stops. */
const fullTail = process.argv.includes("--full-tail");
/** Render only the first N seconds — a smoke test for the filter graph before a full run. */
const limitSec = Number(
  process.argv
    .slice(2)
    .find((a) => a.startsWith("--seconds="))
    ?.slice("--seconds=".length) ?? NaN,
);

const match = await getMatch(matchId);
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

const useVaapi = !forceCpu && vaapiAvailable();
// A `--seconds` run is a smoke test and must not land on the finished MP4: it did once, and a
// published match's final-<id>.mp4 became a 20-second stub.
const outPath = Number.isFinite(limitSec)
  ? path.join(outDir, `smoke-${matchId}.mp4`)
  : exportOutputPath(outDir, matchId);
console.error(
  `Exporting match ${matchId} (${playerLeft.nickname} vs ${playerRight.nickname}) ` +
    `with ${useVaapi ? "h264_vaapi" : "libx264"}...`,
);

const started = Date.now();
await runFastExport(
  {
    leftClip: {
      path: clipFor(playerLeft.nickname),
      durationSec: leftDur,
      matchOffsetIntoClipSec: leftStartSec,
      clipName: `${playerLeft.nickname} POV`,
    },
    rightClip: {
      path: clipFor(playerRight.nickname),
      durationSec: rightDur,
      matchOffsetIntoClipSec: rightStartSec,
      clipName: `${playerRight.nickname} POV`,
    },
    topPath: overlay.top,
    // The winner's dot fills where the run ends; a ranked match has no second still.
    ...(existsSync(overlay.topEnd) && match.result.time > 0
      ? { topEndPath: overlay.topEnd, topEndAtSec: runEndOnTimelineSec }
      : {}),
    splits,
    timerPath: overlay.timer,
    introPath: overlay.intro,
    introOffsetSec: 0,
    fps: 60,
    // The overlay spans lead-in + run + post-roll and starts at timeline 0, so it is the
    // timeline's length.
    totalDurationSec: Number.isFinite(limitSec) ? limitSec : totalDurationSec,
    outPath,
    useVaapi,
    povAudioPan: config.povAudioPan,
  },
  (line) => process.stderr.write(`  ${line}\n`),
);

console.error(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s: ${outPath}`);
console.log(JSON.stringify({ matchId, outPath, anchorSec: ANCHOR_SEC, introSec: introDur }, null, 2));
