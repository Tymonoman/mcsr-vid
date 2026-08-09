import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { buildKdenliveProject, type KdenliveClipInput } from "./kdenliveProject.js";
import { computeSyncOffset } from "./sync.js";
import { downloadMatchVods, PRE_ROLL_SEC, type VodWindow } from "./vodAcquisition.js";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;
const SYNC_CONFIDENCE_THRESHOLD = 0.15;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function runNpmScript(script: string, arg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["run", script, "--", arg], { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

async function probeDurationSec(filePath: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(out.trim());
}

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run generate-project -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const matchId = parseMatchId(input);
const match = await getMatch(matchId);

const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) {
  throw new Error(`Match ${matchId} does not have two players.`);
}
if (match.vod.length < 2) {
  throw new Error(
    `Match ${matchId} has ${match.vod.length}/2 VODs attached; the Kdenlive project needs both.`,
  );
}

const outDir = path.join("media", String(matchId));

const vodForPlayer = (uuid: string) => match.vod.find((v) => v.uuid === uuid);
const vodLeft = vodForPlayer(playerLeft.uuid);
const vodRight = vodForPlayer(playerRight.uuid);
if (!vodLeft || !vodRight) {
  throw new Error(`Match ${matchId}: could not find a VOD for both players[0] and players[1].`);
}

const pathFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);
let windows: VodWindow[];
if (existsSync(pathFor(playerLeft.nickname)) && existsSync(pathFor(playerRight.nickname))) {
  console.error(`Reusing existing VOD downloads in ${outDir}/`);
  windows = [
    {
      playerUuid: vodLeft.uuid,
      playerNickname: playerLeft.nickname,
      sourceUrl: vodLeft.url,
      path: pathFor(playerLeft.nickname),
      matchOffsetIntoVodSec: 0,
      matchOffsetIntoClipSec: PRE_ROLL_SEC,
    },
    {
      playerUuid: vodRight.uuid,
      playerNickname: playerRight.nickname,
      sourceUrl: vodRight.url,
      path: pathFor(playerRight.nickname),
      matchOffsetIntoVodSec: 0,
      matchOffsetIntoClipSec: PRE_ROLL_SEC,
    },
  ];
} else {
  console.error(`Downloading VODs for match ${matchId}...`);
  windows = await downloadMatchVods(match, outDir);
}

const leftWindow = windows.find((w) => w.playerUuid === playerLeft.uuid);
const rightWindow = windows.find((w) => w.playerUuid === playerRight.uuid);
if (!leftWindow || !rightWindow) {
  throw new Error("Downloaded windows don't match players[0]/players[1].");
}

console.error(`Refining sync via audio cross-correlation...`);
let rightOffsetSec = rightWindow.matchOffsetIntoClipSec;
try {
  const sync = await computeSyncOffset(
    leftWindow.path,
    rightWindow.path,
    leftWindow.matchOffsetIntoClipSec,
    rightWindow.matchOffsetIntoClipSec,
  );
  if (sync.confidence >= SYNC_CONFIDENCE_THRESHOLD) {
    console.error(
      `  Using refined offset (confidence ${sync.confidence.toFixed(3)}): ` +
        `${rightOffsetSec.toFixed(2)}s -> ${sync.clipBCueTimeSec.toFixed(2)}s`,
    );
    rightOffsetSec = sync.clipBCueTimeSec;
  } else {
    console.error(
      `  Confidence too low (${sync.confidence.toFixed(3)}); keeping coarse API-derived offset.`,
    );
  }
} catch (err) {
  console.error(`  Sync refinement failed (${(err as Error).message}); keeping coarse offset.`);
}

const overlayPath = path.join(outDir, "overlay.mov");
if (!existsSync(overlayPath)) {
  console.error(`Rendering overlay for match ${matchId}...`);
  await runNpmScript("render-overlay", String(matchId));
} else {
  console.error(`Reusing existing overlay render: ${overlayPath}`);
}

const thumbnailPath = path.join(outDir, "thumbnail.png");
if (!existsSync(thumbnailPath)) {
  console.error(`Generating thumbnail for match ${matchId}...`);
  await runNpmScript("generate-thumbnail", String(matchId));
} else {
  console.error(`Reusing existing thumbnail: ${thumbnailPath}`);
}

console.error("Probing clip durations...");
const [leftDurationSec, rightDurationSec, overlayDurationSec] = await Promise.all([
  probeDurationSec(leftWindow.path),
  probeDurationSec(rightWindow.path),
  probeDurationSec(overlayPath),
]);

const leftClip: KdenliveClipInput = {
  path: path.resolve(leftWindow.path),
  durationSec: leftDurationSec,
  matchOffsetIntoClipSec: leftWindow.matchOffsetIntoClipSec,
  clipName: `${leftWindow.playerNickname} POV`,
};
const rightClip: KdenliveClipInput = {
  path: path.resolve(rightWindow.path),
  durationSec: rightDurationSec,
  matchOffsetIntoClipSec: rightOffsetSec,
  clipName: `${rightWindow.playerNickname} POV`,
};
const overlayClip: KdenliveClipInput = {
  path: path.resolve(overlayPath),
  durationSec: overlayDurationSec,
  matchOffsetIntoClipSec: PRE_ROLL_SEC,
  clipName: "Stat Overlay",
};

const projectXml = buildKdenliveProject({
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  leftClip,
  rightClip,
  overlayClip,
  projectName: `Match ${matchId} - ${leftWindow.playerNickname} vs ${rightWindow.playerNickname}`,
});

const projectPath = path.join(outDir, `match-${matchId}.kdenlive`);
await writeFile(projectPath, projectXml, "utf8");

console.error(`Done: ${projectPath}`);
console.log(
  JSON.stringify(
    {
      matchId,
      projectPath: path.resolve(projectPath),
      thumbnailPath: path.resolve(thumbnailPath),
    },
    null,
    2,
  ),
);
