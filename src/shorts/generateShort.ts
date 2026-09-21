import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { requireArg } from "../cliArgs.js";
import { describeError } from "../errorText.js";
import { config, matchDir } from "../config.js";
import { getMatch, getUser, parseMatchId } from "../api/mcsrApi.js";
import { reasonerConfigured } from "./reasoner.js";
import { distinctShortMoments, SHORT_WINDOW_SEC, type ShortMoment } from "./shortMoment.js";
import { reasonShortMoments } from "./shortReason.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { renderShort } from "./shortRender.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { eloAtMatchStart } from "../pipeline/overlayProps.js";
import { playoffContextFor, playoffPhrase } from "../playoffs/playoffs.js";
import { buildShortDescription, buildShortTitle, resolveShortHookFor } from "./shortHook.js";
import { readChatTimes } from "../api/twitchChat.js";
import { estimatedRunSec } from "../pipeline/vodAcquisition.js";

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
// An explicit window start, ms from match start. Row indices are not stable — the reasoner
// reorders them and the scorer's weights change between releases — so anything reproducing a
// particular cut (a re-cut, or the operator saying "start it here" while watching) names the
// window rather than the row.
const atMs = flag("at") === undefined ? null : Number(flag("at"));
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
// Before any elo is read. A playoff game carries no `changes[]`, so `eloAtMatchStart` answers
// from the frozen season-end rating this resolves; the Short is a separate process from the
// pipeline, so without it the board falls back to the *new* season's live rating — a different
// number for the same match than the overlay, the thumbnail and the description show, or `0`
// right after the rollover, when the live rating is still null.
const playoff = await playoffContextFor(match);
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

// The one definition of how long the run was, shared with the VOD download window: result.time,
// or the forfeit fallback when the match record has none. `momentOpts` is kept as a value because
// the reasoner is handed the same options the ranking used.
const runMs = estimatedRunSec(match) * 1000;
const momentOpts = {
  leftUuid: playerLeft.uuid,
  rightUuid: playerRight.uuid,
  runMs,
  windowSec: seconds,
  chatAtSec,
};
let moments = distinctShortMoments(match, momentOpts, 5);
// The heuristic's own answer, before the reasoner is allowed to reorder it: the tuning log needs
// the two predictions separately or it cannot tell them apart later.
const heuristicTop = moments[0];
let reasonerApplied = false;
if (moments.length === 0) {
  throw new Error(`Match ${matchId} has no timeline events worth cutting a Short from.`);
}
// The reasoner's choice moves to index 0 — the nightly's `--pick=0`. Its answer is read from
// short-reason.json when the dashboard already asked, so the order here is the one the panel
// showed and `--pick` means the row the operator clicked.
if (reasonerConfigured()) {
  const reasoned = await reasonShortMoments(match, moments, momentOpts, outDir);
  moments = reasoned.moments;
  reasonerApplied = reasoned.reasoner.applied;
  if (reasoned.reasoner.applied) console.error(`Reasoner: ${reasoned.reasoner.why ?? "(no reason given)"}`);
}

/**
 * The window an operator asked for by time, clamped inside the run.
 *
 * It carries the scored events that fall inside it, so the closing card's "did this reach the
 * finish" test and the log line read the same as a ranked window's. The score is 0 because
 * nothing ranked it: a hand-picked window does not compete with the others, it replaces them.
 */
function windowAt(
  startMs: number,
  ranked: readonly ShortMoment[],
  runMs: number,
  windowSec: number,
): ShortMoment {
  const windowMs = windowSec * 1000;
  const start = Math.max(0, Math.min(Math.round(startMs), Math.max(0, runMs - windowMs)));
  const endMs = start + windowMs;
  const seen = new Set();
  const events = ranked
    .flatMap((m) => m.events)
    .filter((e) => e.time >= start && e.time < endMs)
    .filter((e) =>
      seen.has(`${e.time}:${e.type}:${e.uuid}`) ? false : seen.add(`${e.time}:${e.type}:${e.uuid}`),
    )
    .sort((a, b) => a.time - b.time);
  return { startMs: start, endMs, score: 0, reason: "chosen by hand", events };
}

const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
console.error(`Candidate moments for ${matchId}:`);
moments.forEach((m, i) => {
  console.error(`  ${i === pick ? ">" : " "} [${i}] ${mmss(m.startMs)}-${mmss(m.endMs)}  ${m.reason}`);
});

// `--at` wins over `--pick`: it is the operator saying where, having watched it.
const moment = atMs === null ? moments[pick] : windowAt(atMs, moments, runMs, seconds);
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

// The offsets the pipeline's sync stage already paid for, so the two POVs show the same instant
// and the moment starts where the scorer thinks it does. A Short is forgiving — it is cut from
// one window, so drift shifts which second you see rather than desyncing anything — but the
// measured error runs to five seconds, which is a quarter of the Short.
// Without sync.json (a match rendered before it existed) the coarse download estimate stands.
const sync = readSyncOffsets(outDir);
const leftStartSec = sync?.left ?? config.preRollSec;
const rightStartSec = sync?.right ?? config.preRollSec;
console.error(
  sync
    ? `Sync: match start ${leftStartSec.toFixed(2)}s / ${rightStartSec.toFixed(2)}s into the clips ` +
        `(sync.json, ${sync.source}, ${(sync.confidence * 100).toFixed(0)}%).`
    : `Sync: no sync.json — using the coarse ${config.preRollSec}s estimate for both POVs.`,
);

// The seed each player carries in the bracket, by uuid — the slot's participant order is the
// bracket's, not the match's, so it cannot be zipped positionally. Absent on a ranked match, and
// then the nameplate keeps showing the ladder rank.
// The rank as it stood when the headline was chosen, not as it stands now. The burned-in hook is
// frozen — it may even quote the rank ("#9 vs #3") — so reading a live rank beside it put two
// contradictory numbers in one frame. Falls back to live for a manifest written before the field.
const committedRanks = (await readManifest(outDir))?.ranks;
const frozenRank = (uuid: string, live: number | null): number | null =>
  committedRanks && uuid in committedRanks ? (committedRanks[uuid] ?? null) : live;

const seedOf = (uuid: string): string | undefined => playoff?.seeds.find((s) => s.uuid === uuid)?.label;

const outPath = path.join(outDir, `short-${matchId}.mp4`);
console.error(`\nRendering ${seconds}s Short from ${mmss(moment.startMs)}...`);
await renderShort({
  topClipPath: clipFor(playerLeft.nickname),
  topMatchStartSec: leftStartSec,
  bottomClipPath: clipFor(playerRight.nickname),
  bottomMatchStartSec: rightStartSec,
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
      eloRank: frozenRank(playerLeft.uuid, userLeft.eloRank),
      ...(seedOf(playerLeft.uuid) ? { seed: seedOf(playerLeft.uuid) } : {}),
      // The same head render the 16:9 overlay and the intro card use, from the same host.
      headUrl: `https://nmsr.nickac.dev/head/${playerLeft.uuid}`,
    },
    bottom: {
      nickname: playerRight.nickname,
      eloRate: eloAtMatchStart(match, playerRight.uuid, userRight.eloRate),
      eloRank: frozenRank(playerRight.uuid, userRight.eloRank),
      ...(seedOf(playerRight.uuid) ? { seed: seedOf(playerRight.uuid) } : {}),
      headUrl: `https://nmsr.nickac.dev/head/${playerRight.uuid}`,
    },
    hook,
    timerStartMs: moment.startMs,
    // The closing card, and only when the cut actually runs to the finish: a mid-run window must
    // never stamp a number the viewer did not watch happen. The time comes from the match record
    // rather than from anything on the board — the reference channel reads theirs off a clock and
    // its card disagrees with the timer visible under it. A forfeit has no time to show at all.
    ...(match.result.time > 0 && moment.endMs >= runMs ? { resultMs: match.result.time } : {}),
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
    playoff ? playoffPhrase(playoff.season, playoff.round, playoff.gameNo) : undefined,
    match.season,
  ),
  "utf8",
);

// Which window this render actually cut, so a re-cut can repeat it. `POST /api/thumbnails/:id/
// rerender` re-cuts the Short behind a new headline, and without this it would reset the moment
// to the top-ranked one — silently discarding a row the operator picked by hand.
await writeFile(
  path.join(outDir, `short-${matchId}.cut.json`),
  JSON.stringify({ pick, startMs: moment.startMs, endMs: moment.endMs }, null, 2),
  "utf8",
);

// One line per render, across every match, so the weights can eventually be tuned against
// something. Right now nothing records which window won or who chose it, so there is no way to
// tell whether the reasoner picks better than the heuristic or whether either beats the
// operator — and that evidence can only be gathered going forward. The operator's own choice is
// the ground truth; the heuristic's top and the reasoner's answer are the two predictions.
// Append-only and best-effort: a Short is not worth failing over a log line.
try {
  await appendFile(
    path.join(config.mediaDir, ".short-picks.jsonl"),
    JSON.stringify({
      matchId,
      cutStartMs: moment.startMs,
      chosenBy: atMs !== null ? "operator-window" : pick === 0 ? "top" : "operator-row",
      heuristicTopStartMs: heuristicTop?.startMs ?? null,
      heuristicTopScore: heuristicTop ? Number(heuristicTop.score.toFixed(2)) : null,
      reasonerApplied: reasonerApplied,
      reachedFinish: moment.endMs >= runMs,
      windowSec: seconds,
    }) + "\n",
    "utf8",
  );
} catch (err) {
  console.error(`could not record the pick: ${describeError(err)}`);
}

console.error(`\nDone: ${outPath}`);
console.log(
  JSON.stringify(
    { matchId, outPath, titlePath, moment: { ...moment, events: moment.events.length } },
    null,
    2,
  ),
);
