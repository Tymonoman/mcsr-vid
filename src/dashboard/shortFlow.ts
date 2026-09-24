/**
 * A match's way from the nightly's export to the channel, as the operator decided it on 23 Sept
 * 2026 — operator time ~0: confirm two hooks, glance at the pick.
 *
 * 1. After the export, the model picks the Short's window (src/shorts/videoPick.ts): one pick at
 *    a time, in this process's queue, because agy watches a whole match per pick.
 * 2. Nothing renders a Short and nothing uploads until the operator saves the hooks
 *    (`saveHooks`): the title hook becomes the edited title, the Short hook `short-<id>.hook.txt`
 *    — or "no Short for this one", and the long-form goes alone.
 * 3. Then the chain runs by itself (`startChain`): render the Short, upload the long-form
 *    (private, the next free publish slot), upload the Short (the long-form's time + 18 h, or an
 *    hour from now if that is later). Uploads only while `youtubeUploadEnabled` and
 *    `nightlyUpload` allow them; otherwise it stops after the render and Publish is the way.
 *
 * The chain is a reconciler rather than a script: every step re-reads the disk and does the first
 * thing still missing, so a hook changed after the render re-cuts the Short, a new pick re-cuts
 * it, and a restart resumes where the files say it stopped (`shortTick`). What each step did is
 * kept in `short-<id>.status.json`, the one record the panel, the list and a restarted server
 * all read.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMatch, getUser } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { hookSuggestions, spoilsTheResult } from "../pipeline/hooks.js";
import { exportMatchStartSec } from "../pipeline/exportFast.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { exportStale, readSyncOffsets } from "../pipeline/syncFile.js";
import { buildTitle, HOOK_PLACEHOLDER, metaPaths, SEPARATOR, withHook } from "../pipeline/title.js";
import { playoffContextFor, playoffSeriesTail, playoffTitleTail } from "../playoffs/playoffs.js";
import {
  gameMatchStarts,
  readSeriesRecord,
  seriesOutputPath,
  type SeriesRecord,
} from "../playoffs/series.js";
import { reasonerConfigured } from "../shorts/reasoner.js";
import {
  buildShortHook,
  buildShortTitle,
  readShortCut,
  readShortHook,
  TITLE_MAX_CHARS,
  type ShortCut,
} from "../shorts/shortHook.js";
import {
  pickFile,
  shortHookFile,
  type MatchRowShort,
  type NightlyShortSummary,
  type SaveHooksRequest,
  type ShortPick,
  type ShortPlanResponse,
  type ShortState,
} from "../shorts/shortPlan.js";
import {
  activityOf,
  endActivity,
  boxFailure,
  readShortLog,
  runningActivities,
  shortLog,
  startActivity,
  stepActivity,
} from "../shorts/shortLog.js";
import { hookProblem, HOOK_MAX_CHARS, pickErrorFile, pickShortMoment } from "../shorts/videoPick.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import {
  channelShortFor,
  channelUploadsSnapshot,
  channelVideoFor,
  refreshChannelUploadsNow,
} from "../youtube/channelUploads.js";
import { publishSlotFor } from "../youtube/publishSlot.js";
import { beginUpload, SHORT_DELAY_MS, uploadRunning, type UploadRequest } from "../youtube/youtubeUpload.js";
import { readUpload, type UploadKind } from "../youtube/youtubeStore.js";
import { hiddenMatchIds, isExported, isShortUploaded, isUploaded } from "./matchShelf.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { shortRunning, spawnShortJob } from "./shortsRoutes.js";

type Step = ShortPlanResponse["errors"][number]["step"];

/* --- short-<id>.status.json -------------------------------------------------------------------- */

interface StepRecord {
  /** `off`: the upload step reached with uploads switched off — Publish is the way. */
  state: "running" | "done" | "failed" | "off";
  at: string;
  detail?: string;
}

export interface ShortStatus {
  /** When the operator last saved the hooks; the chain runs only after this. */
  hooksSavedAt?: string;
  noShort?: boolean;
  steps: Partial<Record<Step, StepRecord>>;
  /** This run's problems, newest first — cleared by the next save, which is the retry. */
  errors: ShortPlanResponse["errors"];
  /** The UTC day the nightly's tick last re-asked the model after a heuristic pick. */
  pickRetriedOn?: string;
  /** A save cleared a failed upload: list the channel before sending it again. */
  recheckChannel?: boolean;
}

const statusFile = (dir: string, matchId: number): string => path.join(dir, `short-${matchId}.status.json`);

export function readStatus(matchId: number): ShortStatus {
  try {
    const s = JSON.parse(
      readFileSync(statusFile(matchDir(matchId), matchId), "utf8"),
    ) as Partial<ShortStatus>;
    return { ...s, steps: s.steps ?? {}, errors: s.errors ?? [] };
  } catch {
    return { steps: {}, errors: [] };
  }
}

/** Read, change, write — synchronously, so two steps of one process can never interleave a write. */
function updateStatus(matchId: number, change: (s: ShortStatus) => void): void {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return;
  const s = readStatus(matchId);
  change(s);
  s.errors = s.errors.slice(0, 20);
  const file = statusFile(dir, matchId);
  writeFileSync(`${file}.part`, JSON.stringify(s, null, 2));
  renameSync(`${file}.part`, file);
}

/* --- The pick queue ---------------------------------------------------------------------------- */

/**
 * How a pick is made; the tests hand in a stand-in for the model. `signal` stops it (the
 * watchdog); `fallback` skips the model and has the heuristic stand in for that reason.
 */
export type Picker = (
  matchId: number,
  opts: { force: boolean; signal?: AbortSignal; fallback?: string },
) => Promise<unknown>;
let picker: Picker = (matchId, opts) =>
  pickShortMoment(matchId, { ...opts, log: (line) => console.error(`pick #${matchId}: ${line}`) });
export const setPicker = (p: Picker): void => {
  picker = p;
};

const queued = new Map<number, Promise<void>>();
const forced = new Set<number>();
let pickingNow: number | null = null;
let tail: Promise<void> = Promise.resolve();

/**
 * A pick is stuck when nothing in it has moved for `stuckMs`. Every stage under it has its own
 * limit (/watch 15 min, the model 25 min an ask), so that long a silence is something with none —
 * an ffmpeg that hangs, a request that never answers — and the queue behind it would wait for
 * ever. Measured from the pick's last log line, not its start: a series' pick can rightly run past
 * 40 minutes. The tests shorten both.
 */
export const pickWatchdog = { stuckMs: 40 * 60_000, everyMs: 60_000 };

const mins = (ms: number): string => `${Math.round(ms / 60_000)} min`;

/**
 * Queue a pick; settles when it has run. One at a time across the box: agy watches the whole
 * match per pick, and two at once would share the lab's four cores with the nightly's encode.
 * A match already queued is not queued twice; `force` (the operator's "pick again") upgrades it.
 * A pick the watchdog stops is replaced by the heuristic's, with why.
 *
 * ponytail: in-process queue — a restart forgets it, and the next GET plan or tick queues again.
 */
export function queuePick(matchId: number, force = false): Promise<void> {
  // A pick already running is the fresh one; forcing it again would re-ask the model afterwards.
  if (force && pickingNow !== matchId) forced.add(matchId);
  const existing = queued.get(matchId);
  if (existing) return existing;
  const ahead = queued.size;
  shortLog(
    matchId,
    "pick",
    `${force ? "Pick again: " : ""}queued for the model${ahead ? ` — ${ahead} ahead of it` : ""}`,
  );
  const job = tail.then(async () => {
    pickingNow = matchId;
    startActivity(matchId, "pick", "starting the pick");
    const controller = new AbortController();
    const watchdog = setInterval(() => {
      const live = stepActivity(matchId, "pick");
      if (live && Date.now() - Date.parse(live.since) > pickWatchdog.stuckMs)
        controller.abort(
          new Error(
            `the pick was stuck — nothing moved for ${mins(pickWatchdog.stuckMs)} after "${live.line}" — and was stopped; Pick again asks the model afresh`,
          ),
        );
    }, pickWatchdog.everyMs);
    try {
      await picker(matchId, { force: forced.delete(matchId), signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        const why = describeError(controller.signal.reason);
        shortLog(matchId, "pick", why, { level: "error" });
        await picker(matchId, { force: true, fallback: why }).catch((e: unknown) =>
          console.error(`pick #${matchId}: ${describeError(e)}`),
        );
      } else {
        shortLog(matchId, "pick", `the pick failed: ${describeError(err)} — Pick again`, { level: "error" });
        console.error(`pick #${matchId}: ${describeError(err)}`);
      }
    } finally {
      clearInterval(watchdog);
      endActivity(matchId, "pick");
      pickingNow = null;
      queued.delete(matchId);
    }
  });
  queued.set(matchId, job);
  tail = job;
  return job;
}

export const pickActivity = (matchId: number): ShortPlanResponse["pickActivity"] =>
  pickingNow === matchId ? "running" : queued.has(matchId) ? "queued" : undefined;

/** The picks waiting their turn, in order — the strip's "queued". */
const queuedPicks = (): number[] => [...queued.keys()].filter((id) => id !== pickingNow);

/** Settles once every pick queued so far has run — what the nightly waits on before it reports. */
export const picksIdle = (): Promise<void> => tail;

/**
 * Queue a pick for a match that has none and still needs one. Never for a Short already on the
 * channel or a match the operator said gets none; a pick that exists is left alone (a re-export
 * does not move the match clock the window is in).
 */
export function ensurePick(matchId: number): Promise<void> | null {
  const dir = matchDir(matchId);
  if (existsSync(pickFile(dir, matchId)) || pickActivity(matchId) || readStatus(matchId).noShort) return null;
  if (existsSync(path.join(dir, "youtube-short.json"))) return null;
  return queuePick(matchId);
}

/* --- What the disk says ------------------------------------------------------------------------ */

interface OnChannel {
  videoId: string | null;
  publishAt: string | null;
  privacyStatus: string | null;
}

/** The upload record, else the channel's pairing, else the manual tick (no id), else null. */
async function onChannel(matchId: number, kind: UploadKind): Promise<OnChannel | null> {
  const record = await readUpload(matchId, kind);
  if (record)
    return { videoId: record.videoId, publishAt: record.publishAt, privacyStatus: record.privacyStatus };
  const video = (kind === "video" ? channelVideoFor : channelShortFor)(matchId, channelUploadsSnapshot());
  if (video)
    return { videoId: video.videoId, publishAt: video.publishAt ?? null, privacyStatus: video.privacyStatus };
  const ticked = kind === "video" ? await isUploaded(matchId) : await isShortUploaded(matchId);
  return ticked ? { videoId: null, publishAt: null, privacyStatus: null } : null;
}

const readJson = <T>(file: string): Promise<T | null> =>
  readFile(file, "utf8").then(
    (text) => JSON.parse(text) as T,
    () => null,
  );

/** The hook half of a title line: everything before the first separator, or null for a placeholder. */
const hookOf = (line: string | undefined): string | null => {
  const first = line?.split("\n")[0] ?? "";
  if (first.trim() === "" || first.includes(HOOK_PLACEHOLDER)) return null;
  return first.split(SEPARATOR)[0]!.trim() || null;
};

interface Facts {
  dir: string;
  exported: boolean;
  series: SeriesRecord | null;
  pick: ShortPick | null;
  pickError: { at: string; message: string } | null;
  titleHook: string | null;
  shortHook: string | null;
  noShort: boolean;
  cut: ShortCut | null;
  shortFile: boolean;
  video: OnChannel | null;
  short: OnChannel | null;
  status: ShortStatus;
}

async function factsOf(matchId: number): Promise<Facts> {
  const dir = matchDir(matchId);
  const status = readStatus(matchId);
  const video = await onChannel(matchId, "video");
  const edited = await readFile(metaPaths(matchId, "title").edited, "utf8").catch(() => undefined);
  // The saved title hook: the edited title's. On a video already on the channel with no edited
  // title, the hook it went out with — it is what a change would have to differ from.
  const uploadedTitle = video ? (await readUpload(matchId, "video"))?.title : undefined;
  return {
    dir,
    exported: isExported(matchId),
    series: await readSeriesRecord(dir),
    pick: await readJson<ShortPick>(pickFile(dir, matchId)),
    pickError: await readJson<{ at: string; message: string }>(pickErrorFile(dir, matchId)),
    titleHook: hookOf(edited) ?? hookOf(uploadedTitle),
    shortHook: await readShortHook(dir, matchId),
    noShort: status.noShort === true,
    cut: await readShortCut(dir, matchId),
    shortFile: existsSync(path.join(dir, `short-${matchId}.mp4`)),
    video,
    short: await onChannel(matchId, "short"),
    status,
  };
}

const hooksSaved = (f: Facts): boolean =>
  (f.titleHook !== null || f.video !== null) && (f.noShort || f.shortHook !== null || f.short !== null);

/** The rendered Short is the one the saved hook and the current pick ask for. */
const shortCurrent = (f: Facts): boolean =>
  f.shortFile &&
  f.cut !== null &&
  f.cut.hook === f.shortHook &&
  f.pick !== null &&
  f.cut.pickCreatedAt === f.pick.createdAt;

const uploadsOn = (): boolean => config.youtubeUploadEnabled && config.nightlyUpload !== "off";

const UPLOADS_OFF =
  "uploads are off (youtubeUploadEnabled / nightlyUpload) — the Short is rendered; Publish is the way";

const NOT_EXPORTED =
  "the long-form is not exported — press Re-encode MP4 on the Final video panel, then save the hooks again";

/* --- The state the list and the panel show ----------------------------------------------------- */

const mmss = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** "Short 6:21–7:02, 41 s, both" — with the game for a series. */
const windowLine = (pick: ShortPick, series: SeriesRecord | null): string => {
  const game = series?.games.find((g) => g.matchId === pick.gameMatchId)?.gameNo;
  return (
    `Short ${game ? `game ${game} ` : ""}${mmss(pick.startMs)}–${mmss(pick.endMs)}, ` +
    `${Math.round((pick.endMs - pick.startMs) / 1000)} s, ${pick.pov}`
  );
};

const when = (iso: string | null): string => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "");

/** The step this process is running for a match's chain right now. */
const chainStep = new Map<number, Step>();

function stateOf(matchId: number, f: Facts): { state: ShortState; detail?: string } {
  // The running step's own words ("running /watch on edcr's stream") before the generic line.
  const activity = pickActivity(matchId);
  if (activity)
    return {
      state: "picking",
      detail:
        activity === "running"
          ? (stepActivity(matchId, "pick")?.line ?? "the model is watching the match")
          : "waiting its turn to be picked",
    };
  const step = chainStep.get(matchId);
  if (step === "render" || shortRunning(matchId))
    return { state: "rendering", detail: stepActivity(matchId, "render")?.line ?? "cutting the Short" };
  if (step === "upload-video" || step === "upload-short" || uploadRunning(matchId))
    return {
      state: "uploading",
      detail:
        (stepActivity(matchId, "upload-video") ?? stepActivity(matchId, "upload-short"))?.line ??
        (step === "upload-short" ? "uploading the Short" : "uploading the long-form"),
    };
  if (f.video && (f.short || f.noShort)) {
    const times = [f.video.publishAt, f.short?.publishAt ?? null].filter((t): t is string => t !== null);
    const future = times.filter((t) => Date.parse(t) > Date.now());
    const lines = `long-form ${when(f.video.publishAt) || "up"}${f.noShort ? ", no Short" : `, Short ${when(f.short?.publishAt ?? null) || "up"}`}`;
    if (future.length > 0) return { state: "scheduled", detail: lines };
    if (f.video.privacyStatus === "private" && !f.video.publishAt)
      return { state: "scheduled", detail: `private with no publish time — set one in Studio (${lines})` };
    return { state: "published", detail: lines };
  }
  const failed = Object.entries(f.status.steps).find(([, s]) => s?.state === "failed");
  if (failed)
    return { state: "failed", detail: f.status.errors[0]?.message ?? `the ${failed[0]} step failed` };
  if (f.status.steps["upload-video"]?.state === "off" || f.status.steps["upload-short"]?.state === "off")
    return { state: "failed", detail: UPLOADS_OFF };
  if (!f.exported && !f.video) return { state: "no-export", detail: "the long-form is not exported yet" };
  if (!hooksSaved(f)) {
    if (!f.pick) return { state: "waiting-for-hook", detail: "not picked yet" };
    return {
      state: "waiting-for-hook",
      detail: `${windowLine(f.pick, f.series)}${f.pickError ? " · model failed, heuristic pick" : ""}`,
    };
  }
  // Saved, nothing running, not all up: between steps, or a step a restart cut short.
  return f.noShort || f.short || shortCurrent(f)
    ? { state: "uploading", detail: "waiting to upload" }
    : { state: "rendering", detail: "waiting to cut the Short" };
}

/** What `GET /api/matches` adds to a row. Disk only — no API call per row. */
export async function matchRowShort(matchId: number): Promise<MatchRowShort> {
  const { state, detail } = stateOf(matchId, await factsOf(matchId));
  return { shortState: state, ...(detail ? { shortDetail: detail } : {}) };
}

/**
 * How a pick's failure says the model cannot be reached at all, as opposed to answering badly —
 * the words of `modelFailure` (videoPick.ts) and the reasoner's own.
 */
const UNREACHABLE =
  /not signed in|sign-in has expired|quota or rate limit|is not installed|not configured|is not set|ENOENT|spawn failed|timed out|did not answer in time/i;

/** The picker's health across the box: the newest thing that happened to any pick decides. */
async function pickerHealth(ids: readonly number[]): Promise<NightlyShortSummary["picker"]> {
  if (!reasonerConfigured())
    return { ok: false, message: "reasonerCommand is not set — every pick is the heuristic's" };
  let lastError: { at: string; message: string } | null = null;
  let lastModel = 0;
  for (const id of ids) {
    const dir = matchDir(id);
    const error = await readJson<{ at: string; message: string }>(pickErrorFile(dir, id));
    if (error && (!lastError || error.at > lastError.at)) lastError = error;
    const pick = await readJson<ShortPick>(pickFile(dir, id));
    if (pick?.source === "agy") lastModel = Math.max(lastModel, Date.parse(pick.createdAt) || 0);
  }
  return lastError && Date.parse(lastError.at) > lastModel && UNREACHABLE.test(lastError.message)
    ? { ok: false, message: lastError.message }
    : { ok: true };
}

/** What `GET /api/nightly` adds: the strip's "3 waiting for a hook ›" and "1 failed ›". */
export async function nightlyShortSummary(): Promise<NightlyShortSummary> {
  const hidden = hiddenMatchIds();
  const ids = listProcessedMatchIds().filter((id) => !hidden.has(id));
  const waitingForHook: number[] = [];
  const failed: number[] = [];
  for (const id of ids) {
    const f = await factsOf(id);
    const { state } = stateOf(id, f);
    // Waiting means a pick is there to glance at; an old match nobody has opened is not nagged about.
    if (state === "waiting-for-hook" && f.pick) waitingForHook.push(id);
    if (state === "failed") failed.push(id);
  }
  return {
    waitingForHook,
    failed,
    picker: await pickerHealth(ids),
    activity: { running: runningActivities(), queued: queuedPicks() },
  };
}

/* --- The plan ---------------------------------------------------------------------------------- */

/**
 * A playoff game whose series video is not this directory's: game 1 before the join, or game
 * 2..n. Its pick, its Short and its upload are the joined series' (game 1's), and picking it as
 * a single match would let the window run past the game's result.
 */
const SERIES_GAME =
  "a playoff game — the series is picked, cut and uploaded as one video from game 1 once every game is joined";
async function seriesGameUnjoined(match: MatchInfo, series: SeriesRecord | null): Promise<boolean> {
  return series === null && (await playoffContextFor(match)) !== null;
}

const dedupe = (lines: readonly (string | null | undefined)[]): string[] => [
  ...new Set(lines.map((l) => l?.trim() ?? "").filter((l) => l !== "")),
];

/**
 * The panel polls the plan while a pick runs, and the chips cost both users (uncached reads
 * against a 500-per-10-minute budget), so they are kept per match and pick for ten minutes.
 *
 * ponytail: unbounded map, one small entry per match opened since boot.
 */
const suggestionCache = new Map<
  number,
  { key: string; at: number; value: ShortPlanResponse["suggestions"] }
>();
const SUGGESTION_TTL_MS = 10 * 60_000;

async function cachedSuggestions(
  matchId: number,
  match: MatchInfo,
  f: Facts,
): Promise<ShortPlanResponse["suggestions"]> {
  const key = f.pick?.createdAt ?? "";
  const hit = suggestionCache.get(matchId);
  if (hit && hit.key === key && Date.now() - hit.at < SUGGESTION_TTL_MS) return hit.value;
  const value = await suggestionsFor(matchId, match, f);
  suggestionCache.set(matchId, { key, at: Date.now(), value });
  return value;
}

async function suggestionsFor(
  matchId: number,
  match: MatchInfo,
  f: Facts,
): Promise<ShortPlanResponse["suggestions"]> {
  const [left, right] = match.players;
  if (!left || !right) return { short: [], title: [] };
  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  const playoff = await playoffContextFor(match);
  const budget = titleFor(match, f.series, playoff);
  const facts = { metrics: computeMetrics(match), match, userLeft, userRight, playoff };
  const committed = (await readManifest(f.dir))?.hookText ?? null;
  const title = await hookSuggestions({ ...facts, maxChars: budget.hookMax, minChars: budget.hookMin });
  const short = await hookSuggestions({ ...facts, maxChars: HOOK_MAX_CHARS, minChars: 0 });
  let moment: string | null = null;
  if (f.pick) {
    const game =
      f.pick.gameMatchId === matchId ? match : await getMatch(f.pick.gameMatchId).catch(() => null);
    const events = (game?.timelines ?? []).filter((e) => e.time >= f.pick!.startMs && e.time < f.pick!.endMs);
    moment = buildShortHook({ ...f.pick, score: 0, reason: "", events }, left.nickname, right.nickname);
  }
  return {
    // The model's proposals (in the operator's own style, videoPick.ts) ahead of the chips.
    title: dedupe([committed, ...(f.pick?.titleHooks ?? []), ...title]).filter(
      (h) => h.length <= budget.hookMax,
    ),
    // Held to the rule the model's own suggestion is: no result, and short enough to read at a
    // glance. No `#` (a rank chip's "#7" is a hashtag in the Short's title) and no line naming
    // both players, which the title already does after the hook.
    short: dedupe([f.pick?.hookSuggestion, committed, ...short, moment]).filter(
      (h) =>
        hookProblem(h) === null &&
        !h.includes("#") &&
        !(h.includes(left.nickname) && h.includes(right.nickname)),
    ),
  };
}

/** The long-form title this match's hook goes into: the series' tail for a series, a playoff game's for one. */
function titleFor(
  match: MatchInfo,
  series: SeriesRecord | null,
  playoff: Awaited<ReturnType<typeof playoffContextFor>>,
) {
  const [left, right] = match.players;
  return buildTitle({
    leftNickname: left?.nickname ?? "?",
    rightNickname: right?.nickname ?? "?",
    ...(series
      ? { suffix: playoffSeriesTail(series.season, series.round) }
      : playoff
        ? { suffix: playoffTitleTail(playoff) }
        : {}),
  });
}

/** The export a preview plays, or null. */
const exportPath = (dir: string, matchId: number): string | null =>
  [seriesOutputPath(dir, matchId), path.join(dir, `final-${matchId}.mp4`), path.join(dir, "final.mp4")].find(
    (file) => existsSync(file),
  ) ?? null;

function syncWeak(matchId: number, f: Facts): boolean {
  const games = f.series ? f.series.games.map((g) => g.matchId) : [matchId];
  const weak = games.some((id) => {
    const sync = readSyncOffsets(matchDir(id));
    return sync === null || sync.confidence < config.syncConfidenceThreshold;
  });
  const video = exportPath(f.dir, matchId);
  return weak || (video !== null && exportStale(f.dir, video).stale);
}

/** The picked window inside the long-form's own video, from where its export put match start. */
function previewOf(matchId: number, f: Facts): ShortPlanResponse["preview"] {
  if (!f.pick || exportPath(f.dir, matchId) === null) return undefined;
  let offset = exportMatchStartSec(f.dir, matchId);
  if (f.series) {
    const i = f.series.games.findIndex((g) => g.matchId === f.pick!.gameMatchId);
    if (i < 0) return undefined;
    offset = gameMatchStarts(f.series.games)[i]!;
  }
  return {
    videoUrl: `/api/export/preview/${matchId}`,
    startSec: offset + f.pick.startMs / 1000,
    endSec: offset + f.pick.endMs / 1000,
  };
}

/**
 * `GET /api/shorts/plan/:id`. Opening an exported match with no pick queues one, so the backlog
 * fills in as it is looked at — unless its long-form is already on the channel: a Studio upload
 * from before the Short flow would spend a whole model watch (80–140k tokens) on a Short nobody
 * asked for, so there it waits for Pick. The suggestions cost the match and both users (cached
 * reads); a failure there costs the suggestions, not the plan.
 */
export async function shortPlan(matchId: number, opts: { queue?: boolean } = {}): Promise<ShortPlanResponse> {
  let f = await factsOf(matchId);
  const match = await getMatch(matchId).catch(() => null);
  const seriesGame = match !== null && (await seriesGameUnjoined(match, f.series));
  if (
    opts.queue &&
    f.exported &&
    !f.pick &&
    !f.noShort &&
    !f.short &&
    !f.video &&
    !pickActivity(matchId) &&
    match &&
    !seriesGame
  )
    void queuePick(matchId);
  const suggestions = match
    ? await cachedSuggestions(matchId, match, f).catch((err: unknown) => {
        console.error(`plan #${matchId}: suggestions — ${describeError(err)}`);
        return { short: [], title: [] };
      })
    : { short: f.pick?.hookSuggestion ? [f.pick.hookSuggestion] : [], title: f.pick?.titleHooks ?? [] };
  f = await factsOf(matchId);
  const { state, detail } =
    seriesGame && !f.video ? { state: "no-export" as const, detail: SERIES_GAME } : stateOf(matchId, f);
  const errors = [
    ...f.status.errors,
    ...(f.pickError ? [{ step: "pick" as const, at: f.pickError.at, message: f.pickError.message }] : []),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const upload = (c: OnChannel | null) =>
    c?.videoId ? { videoId: c.videoId, ...(c.publishAt ? { publishAt: c.publishAt } : {}) } : undefined;
  const preview = previewOf(matchId, f);
  const activity = pickActivity(matchId);
  const live = activityOf(matchId);
  return {
    matchId,
    pick: f.pick,
    log: readShortLog(matchId, 60),
    ...(live ? { activity: live } : {}),
    ...(activity ? { pickActivity: activity } : {}),
    shortHook: f.shortHook,
    titleHook: f.titleHook,
    ...(f.noShort ? { noShort: true } : {}),
    ...(syncWeak(matchId, f) ? { syncWeak: true } : {}),
    suggestions,
    state,
    ...(detail ? { detail } : {}),
    errors,
    ...(preview ? { preview } : {}),
    uploads: {
      ...(upload(f.video) ? { video: upload(f.video) } : {}),
      ...(upload(f.short) ? { short: upload(f.short) } : {}),
    },
  };
}

/* --- Saving the hooks -------------------------------------------------------------------------- */

type Refusal = { status: number; error: string };

const LOCKED = (what: string, id: string | null) =>
  `the ${what} is already on the channel${id ? ` (${id})` : ""} — changing its hook would need a re-upload, which is the operator's call`;

/**
 * `PUT /api/shorts/hooks/:id`: writes the title hook as the edited title (the pipeline's own
 * builder, the series' tail for a series) and the Short hook file — or records "no Short" — then
 * starts the chain. A hook of a video already on the channel is locked: the same text is fine
 * (the Short's half can still be saved), a different one is refused.
 */
export async function saveHooks(
  matchId: number,
  body: unknown,
  deps?: Partial<ChainDeps>,
): Promise<Refusal | null> {
  // Two saves of one match at once would interleave their files — one's title, the other's
  // Short hook. The second is refused rather than queued: the panel shows it and the operator
  // presses again with what is on screen.
  if (saving.has(matchId)) return refuse(matchId, { status: 409, error: SAVE_RACING });
  saving.add(matchId);
  try {
    const refused = await writeHooks(matchId, body, deps);
    // A 409 or 503 is the state of the match, not a typo in a field: worth the log.
    return refused && refused.status !== 400 ? refuse(matchId, refused) : refused;
  } finally {
    saving.delete(matchId);
  }
}

const saving = new Set<number>();
const SAVE_RACING = "another save of this match is still being written — press Save again in a moment";

function refuse(matchId: number, refusal: Refusal): Refusal {
  shortLog(matchId, "chain", `save refused: ${refusal.error}`, { level: "warn" });
  return refusal;
}

async function writeHooks(
  matchId: number,
  body: unknown,
  deps?: Partial<ChainDeps>,
): Promise<Refusal | null> {
  const req = (typeof body === "object" && body !== null ? body : {}) as Partial<SaveHooksRequest>;
  const titleHook = typeof req.titleHook === "string" ? req.titleHook.trim() : "";
  const noShort = req.noShort === true;
  const shortHook = noShort ? null : typeof req.shortHook === "string" ? req.shortHook.trim() : "";
  if (titleHook === "")
    return { status: 400, error: "expected { titleHook, shortHook | null, noShort? } with a title hook" };
  if (!noShort && !shortHook) return { status: 400, error: "a Short hook, or noShort: true for no Short" };
  if ([titleHook, shortHook ?? ""].some((h) => /[<>\n\r]/.test(h)))
    return { status: 400, error: "a hook is one line with no < or >" };

  const dir = matchDir(matchId);
  if (!existsSync(dir)) return { status: 404, error: `no working directory for match ${matchId}` };
  if (uploadRunning(matchId))
    return { status: 409, error: "an upload of this match is in flight — wait for it to finish" };
  const f = await factsOf(matchId);
  if (f.video && f.titleHook !== null && titleHook !== f.titleHook)
    return { status: 409, error: LOCKED("long-form", f.video.videoId) };
  if (f.short && (noShort || (f.shortHook !== null && shortHook !== f.shortHook)))
    return { status: 409, error: LOCKED("Short", f.short.videoId) };
  // Nothing names the winner (CLAUDE.md): a typed hook is held to the chips' rule. Only a hook
  // this save writes — an uploaded one is locked and stays as it went out.
  const spoiler = [f.video ? "" : titleHook, f.short ? "" : (shortHook ?? "")].find(
    (h) => h !== "" && spoilsTheResult(h),
  );
  if (spoiler)
    return {
      status: 400,
      error: `"${spoiler}" gives the result away — a hook never names the winner or how the series went; reword it`,
    };

  let match: MatchInfo;
  try {
    match = await getMatch(matchId);
  } catch (err) {
    return {
      status: 503,
      error: `the match record could not be read (${describeError(err)}) — nothing was saved; save again once the MCSR API answers`,
    };
  }
  const [left, right] = match.players;
  if (!left || !right) return { status: 404, error: `match ${matchId} does not have two players` };
  if (!f.video && (await seriesGameUnjoined(match, f.series))) return { status: 409, error: SERIES_GAME };
  const built = titleFor(match, f.series, f.series ? null : await playoffContextFor(match));
  if (!f.video) {
    if (titleHook.length > built.hookMax)
      return {
        status: 400,
        error: `the title hook is ${titleHook.length} characters; this title has room for ${built.hookMax}`,
      };
  }
  if (shortHook && !f.short) {
    const title = buildShortTitle(shortHook, left.nickname, right.nickname);
    if (title.length > TITLE_MAX_CHARS)
      return {
        status: 400,
        error: `the Short's title would be ${title.length} characters (YouTube's cap is ${TITLE_MAX_CHARS})`,
      };
  }

  try {
    if (!f.video)
      await writeFile(metaPaths(matchId, "title").edited, `${withHook(built, titleHook).title}\n`, "utf8");
    if (shortHook && !f.short) await writeFile(shortHookFile(dir, matchId), `${shortHook}\n`, "utf8");
    // No Short: no hook file either, so nothing can cut or upload one behind the operator's back.
    if (noShort) await rm(shortHookFile(dir, matchId), { force: true });
    updateStatus(matchId, (s) => {
      s.hooksSavedAt = new Date().toISOString();
      s.noShort = noShort || undefined;
      // A save is the retry: what failed last time is tried again, and its errors go with it. An
      // upload that failed may still have reached YouTube (the connection lost after the last
      // chunk): the channel is listed before it is sent again.
      for (const [step, rec] of Object.entries(s.steps))
        if (rec?.state !== "done") {
          if (step.startsWith("upload") && rec?.state !== "off") s.recheckChannel = true;
          delete s.steps[step as Step];
        }
      s.errors = [];
    });
  } catch (err) {
    const text = describeError(err);
    return { status: 507, error: boxFailure("saving the hooks", text) ?? `saving the hooks failed: ${text}` };
  }
  shortLog(
    matchId,
    "chain",
    `hooks saved — title: ${JSON.stringify(titleHook)}, ${noShort ? "no Short" : `Short: ${JSON.stringify(shortHook)}`}`,
  );
  const step = chainStep.get(matchId);
  if (chains.has(matchId))
    shortLog(
      matchId,
      "chain",
      `saved while ${step ? `the ${step} step runs` : "the chain runs"} — it looks again when that ends (a changed hook re-cuts the Short)`,
    );
  void startChain(matchId, deps);
  return null;
}

/* --- The chain --------------------------------------------------------------------------------- */

export interface ChainDeps {
  /** Render the Short (`npm run short`); the failure's last line, or null. */
  render: (matchId: number) => Promise<string | null>;
  upload: (matchId: number, req: UploadRequest) => ReturnType<typeof beginUpload>;
  pick: (matchId: number) => Promise<void>;
  /** List the channel now — before re-sending an upload a restart cut short. */
  refreshChannel: () => Promise<unknown>;
  now: () => number;
}

const liveDeps = (): ChainDeps => ({
  // Through shortsRoutes' job table, so the delete guard, the progress stream and the log see it.
  render: (matchId) => spawnShortJob(matchId),
  upload: beginUpload,
  pick: (matchId) => queuePick(matchId),
  refreshChannel: () => refreshChannelUploadsNow(),
  now: Date.now,
});

/**
 * When the Short goes public: 18 h after the long-form (it lands while the match video is still
 * fresh in Browse), or an hour from now if that is later. A long-form already public gives the
 * hour; one private with no time gives none, and the Short waits private beside it.
 */
export function shortPublishAt(video: OnChannel | null, nowMs: number): Date | null {
  const soonest = nowMs + 3600_000;
  if (video?.publishAt) return new Date(Math.max(Date.parse(video.publishAt) + SHORT_DELAY_MS, soonest));
  if (video && video.privacyStatus !== null && video.privacyStatus !== "private") return new Date(soonest);
  return null;
}

async function uploadOne(matchId: number, kind: UploadKind, deps: ChainDeps): Promise<string | null> {
  let publishAt: Date | null = null;
  if (config.nightlyUpload === "scheduled") {
    if (kind === "video") {
      const slot = await publishSlotFor(matchId, deps.now());
      if (slot.why) shortLog(matchId, "chain", `publish slot ${slot.at.toISOString()}: ${slot.why}`);
      publishAt = slot.at;
    } else publishAt = shortPublishAt(await onChannel(matchId, "video"), deps.now());
  }
  if (kind === "video" && !isExported(matchId)) return NOT_EXPORTED;
  const begun = await deps.upload(matchId, {
    kind,
    privacyStatus: "private",
    ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
  });
  if ("error" in begun) return begun.error;
  const done = await begun.finished;
  if (done.error) return done.error;
  // Up, with a post-insert problem (a playlist cap, a thumbnail): a problem on the way, not a failure.
  const step: Step = kind === "video" ? "upload-video" : "upload-short";
  if (done.warnings.length)
    updateStatus(matchId, (s) => {
      for (const w of done.warnings)
        s.errors.unshift({ step, at: new Date(deps.now()).toISOString(), message: w });
    });
  return null;
}

/** One step: recorded as running, then done or failed with its error. True when it succeeded. */
async function runStep(matchId: number, step: Step, fn: () => Promise<string | null>): Promise<boolean> {
  const at = () => new Date().toISOString();
  updateStatus(matchId, (s) => {
    s.steps[step] = { state: "running", at: at() };
  });
  chainStep.set(matchId, step);
  let error: string | null;
  try {
    error = await fn();
  } catch (err) {
    // The step's own module logs what it returns; a throw is nobody's line but this one.
    const text = describeError(err);
    error = boxFailure(`the ${step} step`, text) ?? text;
    shortLog(matchId, "chain", `the ${step} step failed: ${error}`, { level: "error", detail: text });
  } finally {
    chainStep.delete(matchId);
  }
  updateStatus(matchId, (s) => {
    s.steps[step] = {
      state: error === null ? "done" : "failed",
      at: at(),
      ...(error ? { detail: error } : {}),
    };
    if (error !== null) s.errors.unshift({ step, at: at(), message: error });
  });
  if (error !== null) console.error(`chain #${matchId}: ${step} failed — ${error}`);
  return error === null;
}

async function advance(matchId: number, deps: ChainDeps): Promise<void> {
  const status = readStatus(matchId);
  const before = status.steps;
  // An upload a restart cut short, or one that failed, may have reached YouTube before the record
  // was written: ask the channel first, or the retry would put a second copy on it.
  if (
    before["upload-video"]?.state === "running" ||
    before["upload-short"]?.state === "running" ||
    status.recheckChannel
  ) {
    updateStatus(matchId, (s) => delete s.recheckChannel);
    shortLog(
      matchId,
      "chain",
      "checking the channel before sending the upload again, so nothing goes up twice",
    );
    await deps.refreshChannel().catch((err: unknown) =>
      shortLog(matchId, "chain", `the channel could not be listed: ${describeError(err)}`, {
        level: "warn",
      }),
    );
  }
  // Every pass does the first thing still missing. Bounded: a step that "succeeds" without
  // changing the disk must not spin.
  let did = false;
  for (let pass = 0; pass < 8; pass++) {
    const f = await factsOf(matchId);
    if (!hooksSaved(f)) return;
    const wantsShort = !f.noShort && f.short === null;
    if (wantsShort && !f.pick) {
      did = true;
      const ok = await runStep(matchId, "pick", async () => {
        // The model watches the finished video: picking without one would pin the heuristic's
        // window under the saved hook, where the daily retry never replaces it.
        if (!f.exported) return NOT_EXPORTED;
        await deps.pick(matchId);
        if (existsSync(pickFile(f.dir, matchId))) return null;
        const error =
          (await readJson<{ message: string }>(pickErrorFile(f.dir, matchId)))?.message ??
          "no pick came back — press Pick again";
        shortLog(matchId, "chain", `no pick to cut: ${error}`, { level: "error" });
        return error;
      });
      if (!ok) return;
      continue;
    }
    if (wantsShort && !shortCurrent(f)) {
      did = true;
      if (f.shortFile && f.cut && f.cut.hook !== f.shortHook)
        shortLog(
          matchId,
          "chain",
          `the Short hook changed since the cut — cutting it again behind ${JSON.stringify(f.shortHook)}`,
        );
      else if (f.shortFile && f.cut && f.pick && f.cut.pickCreatedAt !== f.pick.createdAt)
        shortLog(matchId, "chain", "a new pick came in since the cut — cutting the Short again");
      if (!(await runStep(matchId, "render", () => deps.render(matchId)))) return;
      continue;
    }
    if (!uploadsOn()) {
      shortLog(matchId, "chain", UPLOADS_OFF, { level: "warn" });
      updateStatus(matchId, (s) => {
        s.steps["upload-video"] = { state: "off", at: new Date().toISOString(), detail: UPLOADS_OFF };
      });
      return;
    }
    if (!f.video) {
      did = true;
      if (!(await runStep(matchId, "upload-video", () => uploadOne(matchId, "video", deps)))) return;
      continue;
    }
    if (wantsShort) {
      did = true;
      if (!(await runStep(matchId, "upload-short", () => uploadOne(matchId, "short", deps)))) return;
      continue;
    }
    if (did)
      shortLog(
        matchId,
        "chain",
        f.noShort
          ? "done — the long-form is on the channel (no Short)"
          : "done — both videos are on the channel",
      );
    return;
  }
}

const chains = new Map<number, Promise<void>>();
const again = new Set<number>();

/**
 * Run the chain for a match, or — when one is running — have it look again once it finishes (a
 * hook saved mid-render). Settles when the match has nothing left to do or a step failed.
 */
export function startChain(matchId: number, deps: Partial<ChainDeps> = {}): Promise<void> {
  const running = chains.get(matchId);
  if (running) {
    again.add(matchId);
    return running;
  }
  const full = { ...liveDeps(), ...deps };
  const run = (async () => {
    do {
      again.delete(matchId);
      await advance(matchId, full);
    } while (again.has(matchId));
  })()
    .catch((err: unknown) => console.error(`chain #${matchId}: ${describeError(err)}`))
    .finally(() => chains.delete(matchId));
  chains.set(matchId, run);
  return run;
}

/** Settles when this match's chain, if one is running, has finished. */
export const chainIdle = (matchId: number): Promise<void> => chains.get(matchId) ?? Promise.resolve();

/* --- The tick ---------------------------------------------------------------------------------- */

let ticking = false;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * At boot and every so often (server.ts): resume the chains a restart cut short, and — at most
 * once a UTC day per match — ask the model again for a pick the heuristic stood in for. The first
 * retry that fails again ends this tick's retries: the model is still unreachable, and one attempt
 * says so as well as twenty; the next tick tries the next match.
 */
export async function shortTick(deps: Partial<ChainDeps> = {}, nowMs = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const hidden = hiddenMatchIds();
    const retry: number[] = [];
    for (const id of listProcessedMatchIds()) {
      const s = readStatus(id);
      // A step recorded as running with no chain in this process: the process that ran it is gone.
      const cut = Object.entries(s.steps).find(([, st]) => st?.state === "running")?.[0];
      if (s.hooksSavedAt && !chains.has(id) && cut) {
        shortLog(id, "chain", `resumed after a restart — the ${cut} step was cut short`, { level: "warn" });
        void startChain(id, deps);
      }
      const dir = matchDir(id);
      if (hidden.has(id) || s.pickRetriedOn === utcDay(nowMs) || !existsSync(pickErrorFile(dir, id)))
        continue;
      const f = await factsOf(id);
      // A pick under a saved hook is the operator's: never replaced behind their back.
      if (f.pick && !hooksSaved(f) && f.short === null && !pickActivity(id)) retry.push(id);
    }
    for (const id of retry) {
      updateStatus(id, (s) => {
        s.pickRetriedOn = utcDay(nowMs);
      });
      shortLog(
        id,
        "chain",
        "the daily retry: asking the model again, since the heuristic stood in last time",
      );
      await queuePick(id, true);
      if (existsSync(pickErrorFile(matchDir(id), id))) break;
    }
  } finally {
    ticking = false;
  }
}
