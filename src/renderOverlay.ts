import path from "node:path";
import { requireArg } from "./cliArgs.js";
import { config } from "./config.js";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import { renderOverlay } from "./overlayRender.js";

const matchId = parseMatchId(requireArg("render-overlay"));
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

const outDir = path.join(config.mediaDir, String(matchId));
const outPath = path.join(outDir, "overlay.mov");
const topOutPath = path.join(outDir, "overlay-top.png");
const introOutPath = path.join(outDir, "overlay-intro.mov");

console.error(`Rendering overlay for match ${matchId}...`);

const result = await renderOverlay({
  match,
  userLeft,
  userRight,
  versus,
  outPath,
  topOutPath,
  introOutPath,
  onProgress: (p) => console.error(`  ${p.phase}: ${p.percent}%`),
});

console.error(`Done: ${outPath}`);
console.log(JSON.stringify(result, null, 2));
