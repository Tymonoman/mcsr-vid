import path from "node:path";
import { requireArg } from "./cliArgs.js";
import { config } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { downloadMatchVods } from "./vodAcquisition.js";

const matchId = parseMatchId(requireArg("download-vods"));
const match = await getMatch(matchId);

if (match.vod.length === 0) {
  console.error(`Match ${matchId} has no VODs attached. Nothing to download.`);
  process.exit(1);
}

const outDir = path.join(config.mediaDir, String(matchId));
console.error(
  `Match ${matchId}: ${match.vod.length}/2 player(s) have a VOD attached. Downloading to ${outDir}/ ...`,
);

const windows = await downloadMatchVods(match, outDir);

console.log(JSON.stringify(windows, null, 2));
