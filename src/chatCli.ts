/**
 * npm run chat -- <matchId>
 *
 * Downloads both players' Twitch chat for the match window and writes chat-<nick>.json beside
 * the media — the input for a chat-replay panel (see src/twitchChat.ts). Prototype entry point:
 * the windows are read back from the description the pipeline wrote, and the window runs from
 * match start to run end plus the post-roll, which is what the video covers.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { chatWindowsFromDescription, fetchVodChat } from "./twitchChat.js";
import { estimatedRunSec } from "./vodAcquisition.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run chat -- <matchId>");
  process.exit(2);
}
const matchId = parseMatchId(arg);
const dir = path.join(config.mediaDir, String(matchId));
const description = await readFile(path.join(dir, `match-${matchId}.description.txt`), "utf8");
const windows = chatWindowsFromDescription(description);
if (windows.length !== 2)
  throw new Error(`expected two POV links in the description, found ${windows.length}`);

const match = await getMatch(matchId);
const spanSec = config.overlayLeadInSec + estimatedRunSec(match) + config.postRollSec;

for (const w of windows) {
  const started = Date.now();
  const messages = await fetchVodChat(w.videoId, w.fromSec, w.fromSec + spanSec);
  const out = path.join(dir, `chat-${w.nickname}.json`);
  await writeFile(
    out,
    JSON.stringify(
      { nickname: w.nickname, videoId: w.videoId, fromSec: w.fromSec, spanSec, messages },
      null,
      1,
    ),
  );
  console.error(
    `${w.nickname}: ${messages.length} messages over ${spanSec.toFixed(0)}s in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${out}`,
  );
}
