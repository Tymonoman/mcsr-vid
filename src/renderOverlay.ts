import { spawn } from "node:child_process";
import path from "node:path";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import { computeOverlayProps } from "./overlayProps.js";
import { PRE_ROLL_SEC, POST_ROLL_SEC, estimatedRunSec } from "./vodAcquisition.js";

const FPS = 60;

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run render-overlay -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const matchId = parseMatchId(input);
const match = await getMatch(matchId);

const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) {
  throw new Error(`Match ${matchId} does not have two players.`);
}

const [userLeft, userRight, versus] = await Promise.all([
  getUser(playerLeft.uuid),
  getUser(playerRight.uuid),
  getVersus(playerLeft.uuid, playerRight.uuid),
]);

const props = computeOverlayProps(match, userLeft, userRight, versus);
const runSec = estimatedRunSec(match);
const durationInFrames = Math.round((PRE_ROLL_SEC + runSec + POST_ROLL_SEC) * FPS);
const timerStartFrame = Math.round(PRE_ROLL_SEC * FPS);

const renderProps = { ...props, timerStartFrame, durationInFrames };

const outDir = path.join("media", String(matchId));
const outPath = path.join(outDir, "overlay.mov");

console.error(`Rendering overlay for match ${matchId} (${durationInFrames} frames @ ${FPS}fps)...`);

await new Promise<void>((resolve, reject) => {
  const proc = spawn(
    "npx",
    [
      "remotion",
      "render",
      "remotion/index.ts",
      "MatchOverlay",
      outPath,
      "--codec=prores",
      "--pro-res-profile=4444",
      `--props=${JSON.stringify(renderProps)}`,
    ],
    { stdio: "inherit" },
  );
  proc.on("error", reject);
  proc.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`remotion render exited with code ${code}`));
  });
});

console.error(`Done: ${outPath}`);
console.log(
  JSON.stringify(
    {
      matchId,
      path: outPath,
      matchOffsetIntoClipSec: PRE_ROLL_SEC,
      durationInFrames,
      fps: FPS,
    },
    null,
    2,
  ),
);
