import path from "node:path";
import { existsSync } from "node:fs";
import { requireArg } from "./cliArgs.js";
import { config } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { overlayPaths, readSplitStills } from "./overlayRender.js";
import { exportOutputPath, runFastExport, vaapiAvailable } from "./exportFast.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { INTRO_SECONDS } from "../remotion/layout.js";

/**
 * npm run export:fast -- <matchId> [--cpu] [--seconds=N]
 *
 * The headless path: renders the finished MP4 straight from the overlay artifacts, without melt
 * and without opening Kdenlive. `--cpu` forces libx264 when the VAAPI encode is unavailable or
 * its quality is not wanted.
 */
const matchId = parseMatchId(requireArg("export:fast"));
const forceCpu = process.argv.includes("--cpu");
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

const outDir = path.join(config.mediaDir, String(matchId));
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

const [leftDur, rightDur, timerDur] = await Promise.all([
  probe(clipFor(playerLeft.nickname)),
  probe(clipFor(playerRight.nickname)),
  probe(overlay.timer),
]);

const useVaapi = !forceCpu && vaapiAvailable();
const outPath = exportOutputPath(outDir, matchId);
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
      matchOffsetIntoClipSec: config.preRollSec,
      clipName: `${playerLeft.nickname} POV`,
    },
    rightClip: {
      path: clipFor(playerRight.nickname),
      durationSec: rightDur,
      matchOffsetIntoClipSec: config.preRollSec,
      clipName: `${playerRight.nickname} POV`,
    },
    topPath: overlay.top,
    splits,
    timerPath: overlay.timer,
    introPath: overlay.intro,
    introOffsetSec: 0,
    fps: 60,
    // The overlay spans lead-in + run + post-roll and starts at timeline 0, so it is the
    // timeline's length.
    totalDurationSec: Number.isFinite(limitSec) ? limitSec : timerDur,
    outPath,
    useVaapi,
  },
  (line) => process.stderr.write(`  ${line}\n`),
);

console.error(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s: ${outPath}`);
console.log(JSON.stringify({ matchId, outPath, anchorSec: ANCHOR_SEC, introSec: INTRO_SECONDS }, null, 2));
