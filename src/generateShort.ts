import path from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { requireArg } from "./cliArgs.js";
import { config, matchDir } from "./config.js";
import { getMatch, getUser, parseMatchId } from "./mcsrApi.js";
import { distinctShortMoments, SHORT_WINDOW_SEC } from "./shortMoment.js";
import { renderShort } from "./shortRender.js";
import { eloAtMatchStart } from "./overlayProps.js";
import { buildShortDescription, buildShortTitle, resolveShortHookFor } from "./shortHook.js";
import { readChatTimes } from "./twitchChat.js";

/**
 * npm run short -- <matchId> [--pick=N] [--seconds=22] [--top-crop=x,y,w,h] [--bottom-crop=...]
 *
 * Picks the most watchable ~22s of the match and renders a finished vertical MP4, plus the title
 * and description the manual upload needs. `--pick`
 * chooses a lower-ranked, non-overlapping alternative when the top one is not the moment you
 * wanted.
 *
 * The crop flags take fractions of the frame (`--top-crop=0.3,0,0.4,1` keeps the middle 40%) and
 * override the automatic game-window detection, which declines whenever a streamer's overlays
 * reach the frame edges — see shortRender.ts.
 */
const matchId = parseMatchId(requireArg("short"));
const flag = (name: string) =>
  process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const pick = Number(flag("pick") ?? 0);
const seconds = Number(flag("seconds") ?? SHORT_WINDOW_SEC);

function parseCrop(name: string): { x: number; y: number; w: number; h: number } | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error(`--${name} must be four fractions between 0 and 1: x,y,w,h (got "${raw}")`);
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}
const topCrop = parseCrop("top-crop");
const bottomCrop = parseCrop("bottom-crop");

const match = await getMatch(matchId);
const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) throw new Error(`Match ${matchId} does not have two players.`);

const outDir = matchDir(matchId);
const clipFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);
for (const p of [playerLeft, playerRight]) {
  if (!existsSync(clipFor(p.nickname))) {
    throw new Error(
      `Missing ${clipFor(p.nickname)}. Run the main pipeline for ${matchId} first — a Short is cut ` +
        `from the same downloaded VODs.`,
    );
  }
}

// Both chats, merged, when the pipeline saved them: where the crowd reacted is a signal the
// timeline does not have. A match without chat files scores exactly as before.
const chatAtSec = readChatTimes(outDir);
if (chatAtSec.length > 0) console.error(`Chat: ${chatAtSec.length} messages inform the moment`);

const moments = distinctShortMoments(
  match,
  {
    leftUuid: playerLeft.uuid,
    rightUuid: playerRight.uuid,
    runMs: match.result.time || 900_000,
    windowSec: seconds,
    chatAtSec,
  },
  5,
);
if (moments.length === 0) {
  throw new Error(`Match ${matchId} has no timeline events worth cutting a Short from.`);
}

const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
console.error(`Candidate moments for ${matchId}:`);
moments.forEach((m, i) => {
  console.error(`  ${i === pick ? ">" : " "} [${i}] ${mmss(m.startMs)}-${mmss(m.endMs)}  ${m.reason}`);
});

const moment = moments[pick];
if (!moment) throw new Error(`--pick=${pick} is out of range; ${moments.length} moments found.`);

const [userLeft, userRight] = await Promise.all([getUser(playerLeft.uuid), getUser(playerRight.uuid)]);

// The hook is the whole first four seconds, so it comes from the best source available rather
// than from the window alone — the operator's own title hook first. Shared with the dashboard's
// Shorts panel so the line it previews is the line that gets burned in.
const hook = await resolveShortHookFor({
  matchId,
  match,
  moment,
  userLeft,
  userRight,
  matchDir: outDir,
});
console.error(`Hook: ${hook}`);

// The same sync the long-form uses would be ideal here, but it costs a video scan per clip and a
// Short is far more forgiving: it is cut from one moment, so a second of absolute drift shifts
// which second you see rather than desyncing anything. The coarse estimate is what the download
// window was built from, so it is exact by construction.
const matchStartSec = config.preRollSec;

const outPath = path.join(outDir, `short-${matchId}.mp4`);
console.error(`\nRendering ${seconds}s Short from ${mmss(moment.startMs)}...`);
await renderShort({
  topClipPath: clipFor(playerLeft.nickname),
  topMatchStartSec: matchStartSec,
  bottomClipPath: clipFor(playerRight.nickname),
  bottomMatchStartSec: matchStartSec,
  startMs: moment.startMs,
  durationSec: seconds,
  ...(topCrop ? { topCrop } : {}),
  ...(bottomCrop ? { bottomCrop } : {}),
  board: {
    top: {
      nickname: playerLeft.nickname,
      // The rating at the time of the match, never user.eloRate (which is the rating now), so
      // the Short agrees with the overlay, the thumbnail and the description.
      eloRate: eloAtMatchStart(match, playerLeft.uuid, userLeft.eloRate),
      eloRank: userLeft.eloRank,
    },
    bottom: {
      nickname: playerRight.nickname,
      eloRate: eloAtMatchStart(match, playerRight.uuid, userRight.eloRate),
      eloRank: userRight.eloRank,
    },
    hook,
    timerStartMs: moment.startMs,
  },
  outPath,
  onProgress: (p) => console.error(`  ${p.phase}: ${p.percent}%`),
});

// The upload is manual, so the two things that have to be typed into the Studio form are
// written next to the video rather than left to be reconstructed from the log: the title is the
// hook that was actually burned in, and the description carries the names and the match page.
// Overwritten on every render, like the pipeline's own title/description files.
const titlePath = path.join(outDir, `short-${matchId}.title.txt`);
await writeFile(titlePath, buildShortTitle(hook), "utf8");
await writeFile(
  path.join(outDir, `short-${matchId}.description.txt`),
  buildShortDescription(
    matchId,
    playerLeft.nickname,
    playerRight.nickname,
    config.youtubePlaylistUrl,
    config.supportUrl,
  ),
  "utf8",
);

console.error(`\nDone: ${outPath}`);
console.log(
  JSON.stringify(
    { matchId, outPath, titlePath, moment: { ...moment, events: moment.events.length } },
    null,
    2,
  ),
);
