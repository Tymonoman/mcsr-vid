/**
 * npm run chat -- <matchId>
 *
 * Downloads both players' Twitch chat for the match window and writes chat-<nick>.json beside
 * the media — the input for a chat-replay panel (see src/twitchChat.ts). Prototype entry point:
 * the windows are read back from the description the pipeline wrote, and the window runs from
 * match start to run end plus the post-roll, which is what the video covers.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { chatWindowsFromDescription, saveChats } from "./twitchChat.js";
import { estimatedRunSec } from "./vodAcquisition.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run chat -- <matchId>");
  process.exit(2);
}
const matchId = parseMatchId(arg);
const dir = matchDir(matchId);
const description = await readFile(path.join(dir, `match-${matchId}.description.txt`), "utf8");
const windows = chatWindowsFromDescription(description);
if (windows.length !== 2)
  throw new Error(`expected two POV links in the description, found ${windows.length}`);

const match = await getMatch(matchId);
const spanSec = config.overlayLeadInSec + estimatedRunSec(match) + config.postRollSec;

// Existing files are kept (the pipeline may have saved them already); delete one to refetch.
const started = Date.now();
const counts = await saveChats(dir, windows, spanSec);
console.error(
  `${Object.keys(counts).length} of ${windows.length} chats written to ${dir} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
