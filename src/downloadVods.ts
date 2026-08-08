import path from "node:path";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { downloadMatchVods } from "./vodAcquisition.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run download-vods -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const matchId = parseMatchId(input);
const match = await getMatch(matchId);

if (match.vod.length === 0) {
  console.error(`Match ${matchId} has no VODs attached. Nothing to download.`);
  process.exit(1);
}

const outDir = path.join("media", String(matchId));
console.error(
  `Match ${matchId}: ${match.vod.length}/2 player(s) have a VOD attached. Downloading to ${outDir}/ ...`,
);

const windows = await downloadMatchVods(match, outDir);

console.log(JSON.stringify(windows, null, 2));
