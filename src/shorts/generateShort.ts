import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { requireArg } from "../cliArgs.js";
import { describeError } from "../errorText.js";
import { config, matchDir } from "../config.js";
import { getMatch, getUser, parseMatchId } from "../api/mcsrApi.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { renderShort } from "./shortRender.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { eloAtMatchStart } from "../pipeline/overlayProps.js";
import { playoffContextFor, playoffPhrase } from "../playoffs/playoffs.js";
import { readSeriesRecord } from "../playoffs/series.js";
import {
  buildShortDescription,
  buildShortTitle,
  endCardText,
  readShortHook,
  TITLE_MAX_CHARS,
  WAITING_FOR_HOOK,
  type ShortCut,
} from "./shortHook.js";
import { decidedAtMs, raceCaptions } from "./raceGap.js";
import { pickFile, SHORT_MAX_MS, SHORT_MIN_MS, type ShortPick } from "./shortPlan.js";

/**
 * npm run short -- <matchId> [--at=<ms>] [--seconds=N] [--top-crop=x,y,w,h] [--bottom-crop=...]
 *
 * Cuts the Short the picker chose (`short-<id>.pick.json`, src/shorts/videoPick.ts) behind the
 * hook the operator confirmed (`short-<id>.hook.txt`, written only by the dashboard's hooks
 * route) — and refuses without that hook: nothing renders a Short before its hook is saved (the
 * operator's rule, 23 Sept 2026). For a series, the id is game 1's: the pick names the game, and
 * the clips and sync are that game's own directory's (the join deletes the games' exports, never
 * their POV clips).
 *
 * `--at` (ms of the game's match clock) and `--seconds` are the operator's overrides of the
 * pick's window; the length stays inside 12–60 s. The crop flags take fractions of the frame and
 * override the automatic game-window detection (see shortRender.ts).
 */
const matchId = parseMatchId(requireArg("short"));
const flag = (name: string) =>
  process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const refuse = (why: string): never => {
  console.error(why);
  process.exit(1);
};

const outDir = matchDir(matchId);
// The gate, before anything else is read: no hook, no Short.
const hook = await readShortHook(outDir, matchId);
if (hook === null) refuse(`${WAITING_FOR_HOOK} — save the hooks on the dashboard first (match ${matchId})`);
if (existsSync(path.join(outDir, "youtube-short.json")))
  refuse(`the Short of ${matchId} is already on the channel — a new cut would need a re-upload`);
const pick = await readFile(pickFile(outDir, matchId), "utf8")
  .then((text) => JSON.parse(text) as ShortPick)
  .catch(() => refuse(`no pick for ${matchId} yet — npm run pick -- ${matchId}`));

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

// The window: the pick's, unless the operator named one.
const atFlag = flag("at");
const secondsFlag = flag("seconds");
const override = atFlag !== undefined || secondsFlag !== undefined;
const lengthMs = Math.min(
  SHORT_MAX_MS,
  Math.max(SHORT_MIN_MS, secondsFlag !== undefined ? Number(secondsFlag) * 1000 : pick.endMs - pick.startMs),
);
const startMs = Math.max(0, atFlag !== undefined ? Math.round(Number(atFlag)) : pick.startMs);
if (!Number.isFinite(startMs) || !Number.isFinite(lengthMs)) refuse("--at and --seconds must be numbers");
const window: ShortPick = { ...pick, startMs, endMs: startMs + lengthMs };

// Placed by the sync the pipeline decided (sync.json, in the picked game's own directory).
// Without it the clips would sit at the coarse estimate and the Short would open seconds off its
// moment: refused, not guessed — and before the API is asked for anything.
const sync = readSyncOffsets(matchDir(window.gameMatchId));
if (!sync)
  refuse(
    `no sync.json for match ${window.gameMatchId} — the Short would be cut seconds off its moment; npm run sync-status -- ${window.gameMatchId} writes it (or fix the sync by hand on the dashboard), then save the hooks again`,
  );

// The API down is the one failure here that is nobody's fault and passes by itself: say so in a
// line the dashboard can show, not a stack.
const unreachable = (err: unknown): never =>
  refuse(
    `the match record could not be read (${describeError(err)}) — the Short was not cut; save the hooks again once the MCSR API answers`,
  );
const game = await getMatch(window.gameMatchId).catch(unreachable);
// Before any elo is read: a playoff game carries no `changes[]`, and `eloAtMatchStart` answers
// from the frozen season-end rating this resolves (the same number the overlay shows).
const playoff = await playoffContextFor(game);
const [playerLeft, playerRight] = game.players;
if (!playerLeft || !playerRight) throw new Error(`Match ${game.id} does not have two players.`);

const gameDir = matchDir(game.id);
const clipFor = (nickname: string) => path.join(gameDir, `${nickname}.mp4`);
const shown =
  window.pov === "both" ? [playerLeft, playerRight] : [window.pov === "left" ? playerLeft : playerRight];
for (const p of shown) {
  if (!existsSync(clipFor(p.nickname)))
    refuse(
      `no clip of ${p.nickname} on disk (${clipFor(p.nickname)}) — a Short is cut from the downloaded VODs: npm run download-vods -- ${game.id} fetches it while the Twitch VOD lasts (14 days, 60 for partners), then save the hooks again`,
    );
}

const series = await readSeriesRecord(outDir);
const title = buildShortTitle(hook!, playerLeft.nickname, playerRight.nickname);
if (title.length > TITLE_MAX_CHARS)
  refuse(
    `the Short's title would be ${title.length} characters (YouTube's cap is ${TITLE_MAX_CHARS}): shorten the hook`,
  );

const leftStartSec = sync!.left;
const rightStartSec = sync!.right;

// The window inside each clip it shows: a pick past a clip's end would encode black. Unreadable
// (ffprobe missing, a stand-in file) is not a reason to refuse.
const clipEndSec = (file: string): number =>
  Number(
    spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { encoding: "utf8" },
    ).stdout?.trim(),
  ) || Infinity;
const mmssOf = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
for (const p of shown) {
  const offset = p === playerLeft ? leftStartSec : rightStartSec;
  const lastMs = (clipEndSec(clipFor(p.nickname)) - offset) * 1000;
  if (window.endMs > lastMs)
    refuse(
      `the window ${mmssOf(window.startMs)}–${mmssOf(window.endMs)} runs past the end of ${p.nickname}'s clip (it ends at ${mmssOf(Math.max(0, lastMs))} on the match clock) — Pick again, or cut it by hand earlier`,
    );
}

const [userLeft, userRight] = await Promise.all([getUser(playerLeft.uuid), getUser(playerRight.uuid)]).catch(
  unreachable,
);
// The rank as it stood when the headline was chosen, not as it stands now (the manifest's ranks).
const committedRanks = (await readManifest(outDir))?.ranks;
const frozenRank = (uuid: string, live: number | null): number | null =>
  committedRanks && uuid in committedRanks ? (committedRanks[uuid] ?? null) : live;
const seedOf = (uuid: string): string | undefined => playoff?.seeds.find((s) => s.uuid === uuid)?.label;

const decided = decidedAtMs(game);
const endCard = endCardText(decided !== null && window.endMs < decided, series !== null);
const captions = raceCaptions(game, window);
const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
console.error(
  `Short of ${matchId}${game.id !== matchId ? ` (game ${game.id})` : ""}: ${mmss(window.startMs)}–${mmss(window.endMs)}, ` +
    `${window.pov}${window.focus ? `, focus ${window.focus}` : ""}${override ? " (operator's window)" : ""}\nHook: ${hook}`,
);

const outPath = path.join(outDir, `short-${matchId}.mp4`);
let printed = 0;
const plate = (p: typeof playerLeft, user: typeof userLeft) => ({
  nickname: p.nickname,
  // The rating at the time of the match, never user.eloRate (the rating now).
  eloRate: eloAtMatchStart(game, p.uuid, user.eloRate),
  eloRank: frozenRank(p.uuid, user.eloRank),
  ...(seedOf(p.uuid) ? { seed: seedOf(p.uuid) } : {}),
  headUrl: `https://nmsr.nickac.dev/head/${p.uuid}`,
});
const clips =
  window.pov === "left"
    ? { pov: "left" as const, topClipPath: clipFor(playerLeft.nickname), topMatchStartSec: leftStartSec }
    : window.pov === "right"
      ? {
          pov: "right" as const,
          bottomClipPath: clipFor(playerRight.nickname),
          bottomMatchStartSec: rightStartSec,
        }
      : {
          pov: "both" as const,
          topClipPath: clipFor(playerLeft.nickname),
          topMatchStartSec: leftStartSec,
          bottomClipPath: clipFor(playerRight.nickname),
          bottomMatchStartSec: rightStartSec,
        };
await renderShort({
  ...clips,
  startMs: window.startMs,
  durationSec: lengthMs / 1000,
  ...(topCrop ? { topCrop } : {}),
  ...(bottomCrop ? { bottomCrop } : {}),
  ...(window.pov === "both" && window.focus ? { focus: window.focus } : {}),
  captions,
  endCard,
  board: {
    top: plate(playerLeft, userLeft),
    bottom: plate(playerRight, userRight),
    hook: hook!,
    timerStartMs: window.startMs,
  },
  outPath,
  // The dashboard reads these lines for its percent (shortsRoutes.ts): one per 5%, not per frame.
  onProgress: (p) => {
    if (p.phase === "compositing" && p.percent < 100 && p.percent - printed < 5) return;
    printed = p.percent;
    console.error(`  ${p.phase}: ${p.percent}%`);
  },
});

const titlePath = path.join(outDir, `short-${matchId}.title.txt`);
await writeFile(titlePath, `${title}\n`, "utf8");
const first = series ? await getMatch(matchId).catch(unreachable) : game;
await writeFile(
  path.join(outDir, `short-${matchId}.description.txt`),
  buildShortDescription(
    matchId,
    first.players[0]?.nickname ?? playerLeft.nickname,
    first.players[1]?.nickname ?? playerRight.nickname,
    config.youtubePlaylistUrl,
    config.supportUrl,
    series
      ? playoffPhrase(series.season, series.round)
      : playoff
        ? playoffPhrase(playoff.season, playoff.round, playoff.gameNo)
        : undefined,
    first.season,
    series ? "series" : "match",
  ),
  "utf8",
);

// What this render cut and behind which hook: the upload refuses a Short whose cut hook is not
// the saved one, and the dashboard's chain re-cuts when the hook or the pick has moved on.
const cut: ShortCut = {
  gameMatchId: game.id,
  startMs: window.startMs,
  endMs: window.endMs,
  pov: window.pov,
  ...(window.focus ? { focus: window.focus } : {}),
  hook: hook!,
  pickCreatedAt: pick.createdAt,
  ...(override ? { override: true } : {}),
  renderedAt: new Date().toISOString(),
};
await writeFile(path.join(outDir, `short-${matchId}.cut.json`), JSON.stringify(cut, null, 2), "utf8");

// One line per cut across every match: which window went out and who chose it, for tuning.
try {
  await appendFile(
    path.join(config.mediaDir, ".short-picks.jsonl"),
    JSON.stringify({
      matchId,
      gameMatchId: game.id,
      cutStartMs: window.startMs,
      cutEndMs: window.endMs,
      pov: window.pov,
      chosenBy: override ? "operator-window" : pick.source,
      ...(pick.model ? { model: pick.model } : {}),
      endsBeforeDecided: decided !== null && window.endMs < decided,
    }) + "\n",
    "utf8",
  );
} catch (err) {
  console.error(`could not record the pick: ${describeError(err)}`);
}

console.error(`\nDone: ${outPath}`);
console.log(JSON.stringify({ matchId, outPath, titlePath, cut }, null, 2));
