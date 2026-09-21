import { requireArg } from "./cliArgs.js";
import { config, matchDir } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { saveChats, vodIdFromUrl } from "./twitchChat.js";
import { downloadMatchVods, estimatedRunSec } from "./vodAcquisition.js";
import { withDiscoveredVods } from "./vodDiscovery.js";

const matchId = parseMatchId(requireArg("download-vods"));
const match = await withDiscoveredVods(await getMatch(matchId));

if (match.vod.length === 0) {
  console.error(`Match ${matchId} has no VODs attached. Nothing to download.`);
  process.exit(1);
}

const outDir = matchDir(matchId);
console.error(
  `Match ${matchId}: ${match.vod.length}/2 player(s) have a VOD attached. Downloading to ${outDir}/ ...`,
);

const windows = await downloadMatchVods(match, outDir);

// The chat expires with the archive; the pipeline saves it after its own download, and a clip
// secured ahead of a render (a playoff weekend's worth, before Twitch's 14 days run out) wants
// it saved now for the same reason.
await saveChats(
  outDir,
  windows.flatMap((w) => {
    const videoId = vodIdFromUrl(w.sourceUrl);
    return videoId ? [{ nickname: w.playerNickname, videoId, fromSec: w.matchOffsetIntoVodSec }] : [];
  }),
  config.overlayLeadInSec + estimatedRunSec(match) + config.postRollSec,
);

console.log(JSON.stringify(windows, null, 2));
