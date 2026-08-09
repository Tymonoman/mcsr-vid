import path from "node:path";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import { renderOverlay } from "./overlayRender.js";

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

const outDir = path.join("media", String(matchId));
const outPath = path.join(outDir, "overlay.mov");

console.error(`Rendering overlay for match ${matchId}...`);

const result = await renderOverlay({
  match,
  userLeft,
  userRight,
  versus,
  outPath,
  onProgress: (p) => console.error(`  ${p.phase}: ${p.percent}%`),
});

console.error(`Done: ${outPath}`);
console.log(JSON.stringify(result, null, 2));
