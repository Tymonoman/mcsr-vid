import path from "node:path";
import { requireArg } from "./cliArgs.js";
import { config } from "./config.js";
import { getMatch, getUser, parseMatchId } from "./mcsrApi.js";
import { renderThumbnail } from "./thumbnailRender.js";

const matchId = parseMatchId(requireArg("generate-thumbnail"));
const match = await getMatch(matchId);

const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) {
  throw new Error(`Match ${matchId} does not have two players.`);
}

const [userLeft, userRight] = await Promise.all([getUser(playerLeft.uuid), getUser(playerRight.uuid)]);

const outDir = path.join(config.mediaDir, String(matchId));
const outPath = path.join(outDir, "thumbnail.png");

console.error(`Rendering thumbnail for match ${matchId}...`);

const result = await renderThumbnail({ match, userLeft, userRight, outPath });

console.error(`Done: ${outPath}`);
console.log(JSON.stringify({ matchId, path: result.path }, null, 2));
