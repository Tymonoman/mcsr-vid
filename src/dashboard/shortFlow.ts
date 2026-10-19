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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMatch, getUser } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { hookLabelProblem, hookSuggestions, spoilsTheResult } from "../pipeline/hooks.js";
import { exportMatchStartSec, readExportRecord } from "../pipeline/exportFast.js";
import { baseExportPath } from "../pipeline/coldOpen.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { exportStale, readSyncOffsets } from "../pipeline/syncFile.js";
import { HOOK_PLACEHOLDER, metaPaths, SEPARATOR, withHook } from "../pipeline/title.js";
import { titleOptions } from "../pipeline/titleOptions.js";
import { dnfRefusal, matchIsDnf, playoffContextFor } from "../playoffs/playoffs.js";
import {
  gameMatchStarts,
  hookFactsMatchId,
  readSeriesRecord,
  seriesOutputPath,
  type SeriesRecord,
} from "../playoffs/series.js";
import { readHandShort, WAITING_FOR_HAND_SHORT, type HandShort } from "../shorts/handShort.js";
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
import {
  hookProblem,
  HOOK_MAX_CHARS,
  pastTitleHooks,
  pickErrorFile,
  pickShortMoment,
  titleFor,
} from "../shorts/videoPick.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import {
  channelShortFor,
  channelUploadsSnapshot,
  channelVideoFor,
  refreshChannelUploadsNow,
} from "../youtube/channelUploads.js";
import { MIN_LEAD_MS, publishSlotFor, slotWarnings } from "../youtube/publishSlot.js";
import { reschedule } from "../youtube/youtube.js";
import {
  beginUpload,
  resumeUpload,
  SHORT_DELAY_MS,
  uploadRunning,
  uploadSessionOnDisk,
  type UploadRequest,
} from "../youtube/youtubeUpload.js";
import {
  nicknameWarnings,
  onVideo,
  readUpload,
  splitTitle,
  uploadTextFor,
  writeUpload,
  type UploadKind,
} from "../youtube/youtubeStore.js";
import { shortDelayMsForDate } from "./experiments.js";
import { hiddenMatchIds, isExported, isShortUploaded, isUploaded } from "./matchShelf.js";
import { blockedOnDisk, listProcessedMatchIds, matchStatusFor } from "./matchStatus.js";
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
  /** The operator's publish time for the long-form (RFC 3339, the kit's field); the upload takes it while it is ahead. */
  publishAt?: string;
  /**
   * A slot this chain has auto-picked for its own upload (RFC 3339) — never the operator's own
   * `publishAt`. Written by `claimSlot` the instant the slot is chosen, before the slow real
   * upload starts, so a concurrent chain's own pick sees it (`storedTimes`,
   * src/youtube/publishSlot.ts); cleared once the upload-video step settles, done or failed.
   */
  slotClaim?: string;
  /** The last auto-hooks save (autoHooksAfterHours, below) — kept across any later save, by the
   *  operator or auto-hooks again, so the morning report can always say what it last picked. */
  autoHooks?: AutoHooksRecord;
  /** Auto-hooks found this match due but its sync weak and not hand-set (`syncWeak`), so saved
   *  nothing: Needs-you lists it until the hooks are saved — by hand, or by a later tick once the
   *  sync reads sound. Cleared by that tick. */
  syncHold?: { at: string; detail: string };
}

/** One auto-hooks save: what it chose and where each hook came from. */
export interface AutoHooksRecord {
  at: string;
  titleHook: string;
  shortHook: string | null;
  source: { title: "nicknames" | "model" | "chip"; short: "model" | "chip" | null };
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

/** Whether any pick is running or waiting its turn right now — restartWhenIdle.ts's gate. */
export const picksRunning = (): boolean => pickingNow !== null || queued.size > 0;

/**
 * Queue a pick for a match that has none and still needs one. Never for a Short already on the
 * channel or a match the operator said gets none; a pick that exists is left alone (a re-export
 * does not move the match clock the window is in).
 */
export function ensurePick(matchId: number): Promise<void> | null {
  // Hand mode still picks after the export: auto-hooks (`autoHooksTick`) is due only once a pick
  // is 6 h old, and the pick carries the model's title hooks — gated off here (11 Oct 2026, first
  // build) no long-form would ever have had its hooks saved, so none would have uploaded. The
  // pick's window renders nothing in hand mode; it is the session's hint for where the Short is.
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

// `.then`'s second argument only catches readFile's own rejection (missing file, no permission) —
// never a throw from JSON.parse inside the fulfillment handler, which rejects the returned
// promise same as any other uncaught throw. A truncated pick.json/pick-error.json (a kill
// mid-write, same shape as the hand-mode review's readHandShort finding) would otherwise throw
// out of factsOf and, through it, every Promise.all over every match — GET /api/matches,
// nightlyShortSummary, shortTick's own loop.
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The hook half of a title line: everything before " | <left> vs <right>" (a typed hook may hold a
 *  " | " itself, `splitTitle`), else before the first separator; null for a placeholder. */
const hookOf = (line: string | undefined): string | null => {
  const first = line?.split("\n")[0] ?? "";
  if (first.trim() === "" || first.includes(HOOK_PLACEHOLDER)) return null;
  return (splitTitle(first)?.hook ?? first.split(SEPARATOR)[0]!).trim() || null;
};

export interface Facts {
  dir: string;
  exported: boolean;
  series: SeriesRecord | null;
  pick: ShortPick | null;
  pickError: { at: string; message: string } | null;
  titleHook: string | null;
  shortHook: string | null;
  noShort: boolean;
  cut: ShortCut | null;
  /** `short-<id>.hand.json` (`config.shortsByHand`) — read regardless of the setting, so a hand
   *  Short built while it was on survives it being switched off again. */
  hand: HandShort | null;
  shortFile: boolean;
  video: OnChannel | null;
  short: OnChannel | null;
  status: ShortStatus;
}

export async function factsOf(matchId: number): Promise<Facts> {
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
    hand: await readHandShort(dir, matchId),
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

/**
 * Whether the Short on disk is the one to upload: in hand mode (`config.shortsByHand`) the hand
 * file and its mp4 are the whole bookkeeping — no pick or hook to match, since nothing here cut
 * it — so the chain must never try to "render" (re-cut) over a hand-made Short.
 */
const shortIsReady = (f: Facts): boolean =>
  config.shortsByHand ? f.shortFile && f.hand !== null : shortCurrent(f);

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

function stateOf(matchId: number, f: Facts, nowMs = Date.now()): { state: ShortState; detail?: string } {
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
    const future = times.filter((t) => Date.parse(t) > nowMs);
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
      detail: `${windowLine(f.pick, f.series)}${!f.pickError ? "" : f.pick.source === "agy" ? " · Pick again failed, the model's earlier pick stands" : " · model failed, heuristic pick"}`,
    };
  }
  // Saved, nothing running, not all up: between steps, or a step a restart cut short.
  return f.noShort || f.short || shortIsReady(f)
    ? { state: "uploading", detail: "waiting to upload" }
    : {
        state: "rendering",
        detail: config.shortsByHand
          ? `${WAITING_FOR_HAND_SHORT} — npm run short:hand`
          : "waiting to cut the Short",
      };
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
  /not signed in|sign-in has expired|quota or rate limit|is not installed|cannot be run|not configured|is not set|ENOENT|spawn failed|timed out|did not answer in time/i;

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
  "a playoff game — the series is picked, cut and uploaded as one video from game 1 once every game is joined: Render the series on the Playoffs board (npm run series -- <game 1>), then save the hooks on game 1";
export async function seriesGameUnjoined(match: MatchInfo, series: SeriesRecord | null): Promise<boolean> {
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
  /** Title hooks up to YouTube's 100-character title instead of the mobile budget — auto-hooks' fallback only. */
  wide = false,
): Promise<ShortPlanResponse["suggestions"]> {
  const [left, right] = match.players;
  if (!left || !right) return { short: [], title: [] };
  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  const playoff = await playoffContextFor(match);
  const budget = titleFor(match, f.series, playoff);
  const titleMax = wide ? TITLE_MAX_CHARS - SEPARATOR.length - budget.generated.length : budget.hookMax;
  // A joined series' hook chips must read the game that actually decided it, not game 1's own
  // numbers (`hookFactsMatchId`, 8 Oct 2026 chip-truth) — a margin, a pace or a lead-change chip
  // quoting game 1 can be checkably false of the video once another game decided it instead.
  const factsId = hookFactsMatchId(matchId, f.series);
  const factsMatch = factsId === matchId ? match : await getMatch(factsId).catch(() => match);
  const facts = { metrics: computeMetrics(factsMatch), match: factsMatch, userLeft, userRight, playoff };
  const committed = (await readManifest(f.dir))?.hookText ?? null;
  const title = await hookSuggestions({ ...facts, maxChars: titleMax, minChars: budget.hookMin });
  const short = await hookSuggestions({ ...facts, maxChars: HOOK_MAX_CHARS, minChars: 0 });
  let moment: string | null = null;
  if (f.pick) {
    const game =
      f.pick.gameMatchId === matchId ? match : await getMatch(f.pick.gameMatchId).catch(() => null);
    const events = (game?.timelines ?? []).filter((e) => e.time >= f.pick!.startMs && e.time < f.pick!.endMs);
    moment = buildShortHook(
      { ...f.pick, score: 0, reason: "", events },
      left.nickname,
      right.nickname,
      game ?? match,
    );
  }
  return {
    // The pick's own titleHooks no longer feed this list (18 Oct 2026): a title hook is
    // `titleOptions.ts`'s job now, not the Short-moment model's. A nickname-pair chip never
    // reaches the panel either (2 Oct 2026, hookProblem's players arg).
    title: dedupe([committed, ...title]).filter(
      (h) => h.length <= titleMax && hookProblem(h, titleMax, match.players) === null,
    ),
    // Held to the rule the model's own suggestion is: no result, and short enough to read at a
    // glance. No `#` (a rank chip's "#7" is a hashtag in the Short's title) and no line naming
    // both players, which the title already does after the hook.
    short: dedupe([f.pick?.hookSuggestion, committed, ...short, moment]).filter(
      (h) =>
        hookProblem(h, HOOK_MAX_CHARS, match.players) === null &&
        !h.includes("#") &&
        !(h.includes(left.nickname) && h.includes(right.nickname)),
    ),
  };
}

/** The export a preview plays, or null. */
const exportPath = (dir: string, matchId: number): string | null =>
  [seriesOutputPath(dir, matchId), path.join(dir, `final-${matchId}.mp4`), path.join(dir, "final.mp4")].find(
    (file) => existsSync(file),
  ) ?? null;

export function syncWeak(matchId: number, f: Facts): boolean {
  const games = f.series ? f.series.games.map((g) => g.matchId) : [matchId];
  const weak = games.some((id) => {
    const sync = readSyncOffsets(matchDir(id));
    // A hand fix (the sync editor's save) is sound whatever its number: it outranks the detector.
    return sync === null || (sync.source !== "manual" && sync.confidence < config.syncConfidenceThreshold);
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
export async function shortPlan(
  matchId: number,
  opts: { queue?: boolean; now?: number } = {},
): Promise<ShortPlanResponse> {
  let f = await factsOf(matchId);
  const match = await getMatch(matchId).catch(() => null);
  const seriesGame = match !== null && (await seriesGameUnjoined(match, f.series));
  if (
    opts.queue &&
    !config.shortsByHand &&
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
    : { short: f.pick?.hookSuggestion ? [f.pick.hookSuggestion] : [], title: [] };
  f = await factsOf(matchId);
  const { state, detail } =
    seriesGame && !f.video
      ? { state: "no-export" as const, detail: SERIES_GAME }
      : stateOf(matchId, f, opts.now);
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
    ...(config.shortsByHand ? { shortsByHand: true } : {}),
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
export type SaveHooksResult = Refusal | { saveWarnings?: string[] } | null;

export async function saveHooks(
  matchId: number,
  body: unknown,
  deps?: Partial<ChainDeps>,
): Promise<SaveHooksResult> {
  // Two saves of one match at once would interleave their files — one's title, the other's
  // Short hook. The second is refused rather than queued: the panel shows it and the operator
  // presses again with what is on screen.
  if (saving.has(matchId)) return refuse(matchId, { status: 409, error: SAVE_RACING });
  saving.add(matchId);
  try {
    const result = await writeHooks(matchId, body, deps);
    if (result && "status" in result) {
      // A 409 or 503 is the state of the match, not a typo in a field: worth the log.
      return result.status !== 400 ? refuse(matchId, result) : result;
    }
    return result;
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
): Promise<SaveHooksResult> {
  const req = (typeof body === "object" && body !== null ? body : {}) as Partial<SaveHooksRequest>;
  let titleHook = typeof req.titleHook === "string" ? req.titleHook.trim() : "";
  const noShort = req.noShort === true;
  let shortHook = noShort ? null : typeof req.shortHook === "string" ? req.shortHook.trim() : "";
  if (titleHook === "")
    return { status: 400, error: "expected { titleHook, shortHook | null, noShort? } with a title hook" };
  if (!noShort && !shortHook) return { status: 400, error: "a Short hook, or noShort: true for no Short" };

  const saveWarnings: string[] = [];

  // A hook with a newline or < > is not refused: newlines become spaces and < > are removed.
  if (/[<>\r\n]/.test(titleHook)) {
    titleHook = titleHook
      .replace(/[\r\n]+/g, " ")
      .replace(/[<>]/g, "")
      .trim();
    saveWarnings.push(
      "newlines in the title hook became spaces and < > were removed (they would break the <HOOK> placeholder and the one-line title files)",
    );
  }
  if (shortHook && /[<>\r\n]/.test(shortHook)) {
    shortHook = shortHook
      .replace(/[\r\n]+/g, " ")
      .replace(/[<>]/g, "")
      .trim();
    saveWarnings.push(
      "newlines in the Short hook became spaces and < > were removed (they would break the one-line title files)",
    );
  }
  if (titleHook === "")
    return { status: 400, error: "expected { titleHook, shortHook | null, noShort? } with a title hook" };
  if (!noShort && !shortHook) return { status: 400, error: "a Short hook, or noShort: true for no Short" };

  const dir = matchDir(matchId);
  if (!existsSync(dir)) return { status: 404, error: `no working directory for match ${matchId}` };
  if (uploadRunning(matchId))
    return { status: 409, error: "an upload of this match is in flight — wait for it to finish" };
  const f = await factsOf(matchId);
  if (f.video && f.titleHook !== null && titleHook !== f.titleHook)
    return { status: 409, error: LOCKED("long-form", f.video.videoId) };
  if (f.short && (noShort || (f.shortHook !== null && shortHook !== f.shortHook)))
    return { status: 409, error: LOCKED("Short", f.short.videoId) };

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
  // Checked before anything else is written: no hooks saved means no pick, no render and no
  // upload for a blocked match — the chain never starts (config.blockedPlayers).
  // The API's pair, and the match's own files (POV clips, chats, title — a renamed runner).
  if (blockedIn([left.nickname, right.nickname]) || blockedOnDisk(dir))
    return { status: 403, error: `match ${matchId} has a blocked player — hooks cannot be saved for it` };
  // Nor for a DNF, by hand or by auto-hooks: saved hooks start a chain whose end is an upload.
  if (await matchIsDnf(matchId))
    return { status: 403, error: dnfRefusal(matchId, "hooks cannot be saved for it") };

  // Spoilers: becomes a warning, save proceeds. After the match read: a runner named at the End is one.
  const spoilers = [f.video ? "" : titleHook, f.short ? "" : (shortHook ?? "")].filter(
    (h) => h !== "" && spoilsTheResult(h, match.players),
  );
  for (const s of new Set(spoilers)) {
    saveWarnings.push(`"${s}" may give the result away — saved anyway`);
  }

  // A nickname, label or epithet for a runner: a warning, never a refusal — "it should just be a
  // suggestion" is the operator's rule for every check here, and both of these went out this way
  // and drew public objection from the runners named (2 Oct 2026): "LCQ vs YN", "ASIAN VS CARNIVORE".
  for (const h of new Set(
    [f.video ? "" : titleHook, f.short ? "" : (shortHook ?? "")].filter((h) => h !== ""),
  )) {
    const problem = hookLabelProblem(h, match.players);
    if (problem) saveWarnings.push(`"${h}" ${problem} — saved anyway`);
  }

  if (!f.video && (await seriesGameUnjoined(match, f.series))) return { status: 409, error: SERIES_GAME };
  const built = titleFor(match, f.series, f.series ? null : await playoffContextFor(match));

  if (!f.video) {
    if (titleHook.length > built.hookMax) {
      const fullTitle = `${titleHook}${SEPARATOR}${built.generated}`;
      if (fullTitle.length > 100) {
        saveWarnings.push(
          `the title is ${fullTitle.length} characters — YouTube refuses over 100, so the upload will stop until it is shorter (this title has room for ${built.hookMax})`,
        );
      } else {
        saveWarnings.push(
          `the title hook is ${titleHook.length} characters (this title has room for ${built.hookMax}) — player names may be cut off on mobile`,
        );
      }
    }
    // A nickname already on the channel for another player (30 Sept 2026 post-mortem): a warning, as every check is.
    saveWarnings.push(...(await nicknameWarnings(`${titleHook}${SEPARATOR}${built.generated}`, matchId)));
  }

  if (shortHook && !f.short) {
    const title = buildShortTitle(shortHook, left.nickname, right.nickname);
    if (title.length > TITLE_MAX_CHARS) {
      saveWarnings.push(
        `the Short's title is ${title.length} characters — YouTube refuses over ${TITLE_MAX_CHARS}, so the upload will stop until it is shorter`,
      );
    }
  }

  try {
    if (!f.video) {
      const titleLine = `${titleHook}${SEPARATOR}${built.generated}`;
      await writeFile(metaPaths(matchId, "title").edited, `${titleLine}\n`, "utf8");
    }
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
  if (saveWarnings.length) {
    shortLog(matchId, "chain", `hooks saved with warnings: ${saveWarnings.join("; ")}`, { level: "warn" });
  }
  const step = chainStep.get(matchId);
  if (chains.has(matchId))
    shortLog(
      matchId,
      "chain",
      `saved while ${step ? `the ${step} step runs` : "the chain runs"} — it looks again when that ends (a changed hook re-cuts the Short)`,
    );
  void startChain(matchId, deps);
  return saveWarnings.length > 0 ? { saveWarnings } : null;
}

/* --- The chain --------------------------------------------------------------------------------- */

export interface ChainDeps {
  /** Render the Short (`npm run short`); the failure's last line, or null. */
  render: (matchId: number) => Promise<string | null>;
  upload: (matchId: number, req: UploadRequest) => ReturnType<typeof beginUpload>;
  pick: (matchId: number) => Promise<void>;
  /** List the channel now — before re-sending an upload a restart cut short. */
  refreshChannel: () => Promise<unknown>;
  /** Settle an upload-video/upload-short step a restart left "running" (`resumeUpload`). */
  resumeUpload: (matchId: number, kind: UploadKind) => Promise<string | null>;
  /** Join the export's planned cold open with the title's hook (src/pipeline/coldOpen.ts); the
   *  failure's last line, or null — done, or nothing planned. */
  coldOpen: (matchId: number, hook: string) => Promise<string | null>;
  now: () => number;
}

const liveDeps = (): ChainDeps => ({
  // Through shortsRoutes' job table, so the delete guard, the progress stream and the log see it.
  render: (matchId) => spawnShortJob(matchId),
  upload: beginUpload,
  pick: (matchId) => queuePick(matchId),
  refreshChannel: () => refreshChannelUploadsNow(),
  resumeUpload,
  coldOpen: joinColdOpenNow,
  now: Date.now,
});

/**
 * `npm run export:fast -- <id> --cold-open=<hook>`, but only when the export planned a cold open
 * (or carries one with another hook): every other match never spawns anything.
 */
function joinColdOpenNow(matchId: number, hook: string): Promise<string | null> {
  const record = readExportRecord(matchDir(matchId), matchId);
  const joined = record?.coldOpenSec !== undefined;
  if (!record || (!record.coldOpen && !joined) || (joined && record.coldOpenHook === hook))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const proc = spawn(
      "npm",
      ["run", "--silent", "export:fast", "--", String(matchId), `--cold-open=${hook}`],
      {
        cwd: path.resolve(new URL("../..", import.meta.url).pathname),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let tail = "";
    proc.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)));
    proc.on("error", (err) => resolve(describeError(err)));
    proc.on("close", (code) =>
      resolve(code === 0 ? null : (tail.trim().split("\n").pop() ?? `export:fast exited ${code}`)),
    );
  });
}

/**
 * When the Short goes public: the standing 18 h after the long-form (it lands while the match
 * video is still fresh in Browse) — or the day the long-form publishes on's Short-delay
 * experiment arm (`shortDelayMsForDate`, src/dashboard/experiments.ts, 1–48 h), when that day has
 * one — or an hour from now if that is later. A long-form already public gives the hour; one
 * private with no time gives none, and the Short waits private beside it.
 */
export function shortPublishAt(video: OnChannel | null, nowMs: number): Date | null {
  const soonest = nowMs + 3600_000;
  if (video?.publishAt) {
    const delayMs = shortDelayMsForDate(video.publishAt.slice(0, 10)) ?? SHORT_DELAY_MS;
    return new Date(Math.max(Date.parse(video.publishAt) + delayMs, soonest));
  }
  if (video && video.privacyStatus !== null && video.privacyStatus !== "private") return new Date(soonest);
  return null;
}

/* --- The publish time -------------------------------------------------------------------------- */

export interface VideoPublishTime {
  at: Date;
  /** The operator's own time (the kit's field), not the next free slot. */
  chosen: boolean;
  /** Why the slot is not the first free one (the pair gap), else null. */
  why: string | null;
  /** The operator's time had passed (or is under the hour's lead), so the next free slot stands in: one line, else null. */
  passed: string | null;
}

/**
 * When the long-form goes out if it uploads now: the operator's time while it is at least
 * `MIN_LEAD_MS` ahead, else the next free slot. YouTube checks the time only once the whole file
 * is up and rejects one that has passed by then.
 */
export async function videoPublishTime(matchId: number, nowMs: number): Promise<VideoPublishTime> {
  const chosen = readStatus(matchId).publishAt;
  if (chosen && Date.parse(chosen) > nowMs + MIN_LEAD_MS)
    return { at: new Date(chosen), chosen: true, why: null, passed: null };
  const slot = await publishSlotFor(matchId, nowMs);
  const gone = chosen && Date.parse(chosen) <= nowMs ? "had passed" : "was under an hour away";
  return {
    ...slot,
    chosen: false,
    passed: chosen
      ? `your time ${when(chosen)} ${gone} — the next free slot instead, ${when(slot.at.toISOString())}`
      : null,
  };
}

/** The chain takes a chosen time only with uploads on and `nightlyUpload` "scheduled"; otherwise it is the kit's copy line. */
const unusedTime = (): string | null =>
  !config.youtubeUploadEnabled
    ? "youtubeUploadEnabled is false on this box: the chain does not upload — this time is for a paste into Studio"
    : config.nightlyUpload === "scheduled"
      ? null
      : `nightlyUpload is "${config.nightlyUpload}" on this box: the chain ${config.nightlyUpload === "off" ? "does not upload" : "uploads private with no publish time"} — this time is for a paste into Studio`;

/** The kit's Publish at: what the field edits, or what the video already did. From the records and the channel scan, no API call. */
export interface PublishTimeView {
  /**
   * open: not on YouTube, the time is editable · scheduled: on YouTube with a record, movable ·
   * studio: scheduled, a Studio upload with no record (moved in Studio) · published ·
   * unscheduled: private, no time · series-game: a playoff game 2..n, out inside game 1's video.
   */
  state: "open" | "scheduled" | "studio" | "published" | "unscheduled" | "series-game";
  at: string | null;
  chosen: boolean;
  /** A time of the operator's is stored (chosen, or passed and standing aside): "use the next free slot" clears it. */
  stored: boolean;
  why: string | null;
  warnings: string[];
}

/** A playoff game after game 1: its series goes out as one video from game 1's directory. */
const SERIES_LATER =
  "a playoff game after game 1 — the series goes out as one video, so set the time on game 1";
/** Or null: a private room whose bracket could not be read, which may be one (r3 #8). */
async function laterSeriesGame(matchId: number): Promise<boolean | null> {
  if (existsSync(path.join(matchDir(matchId), "series.json"))) return false;
  const match = await getMatch(matchId).catch(() => null);
  if (!match) return false;
  try {
    return ((await playoffContextFor(match, true))?.gameNo ?? 1) > 1;
  } catch {
    return null;
  }
}

export async function publishTimeView(matchId: number, nowMs: number): Promise<PublishTimeView> {
  // Before the record: a game folder the channel scan paired to the series video holds one too.
  if (await laterSeriesGame(matchId))
    return { state: "series-game", at: null, chosen: false, stored: false, why: SERIES_LATER, warnings: [] };
  const video = await onChannel(matchId, "video");
  if (!video) {
    const t = await videoPublishTime(matchId, nowMs);
    const unused = t.chosen ? unusedTime() : null;
    return {
      state: "open",
      at: t.at.toISOString(),
      chosen: t.chosen,
      stored: t.chosen || t.passed !== null,
      why: t.passed ?? t.why,
      warnings: t.chosen
        ? [...(unused ? [unused] : []), ...(await slotWarnings(matchId, t.at.getTime(), nowMs))]
        : [],
    };
  }
  // The record is the kit's word — a public video's scan entry has lost its time — except where it
  // says less than the scan's entry for the same video: private with no time (a Studio upload
  // recorded before it kept one), or no time ahead while the scan has it scheduled (moved in Studio).
  const ahead = (t: string | null | undefined): boolean => !!t && Date.parse(t) > nowMs;
  const scan = channelUploadsSnapshot().find((v) => v.videoId === video.videoId);
  const live =
    scan &&
    !ahead(video.publishAt) &&
    ((scan.privacyStatus === "private" && ahead(scan.publishAt)) ||
      (video.privacyStatus === "private" && !video.publishAt))
      ? { ...video, publishAt: scan.publishAt ?? null, privacyStatus: scan.privacyStatus }
      : video;
  const view = { chosen: false, stored: false, why: null, warnings: [] };
  if (live.privacyStatus === "private" && live.publishAt && Date.parse(live.publishAt) > nowMs)
    // Moved on the press only with a record here (a dashboard upload, an adopted draft).
    return (await readUpload(matchId, "video"))
      ? {
          ...view,
          state: "scheduled",
          at: live.publishAt,
          warnings: await slotWarnings(matchId, Date.parse(live.publishAt), nowMs),
        }
      : { ...view, state: "studio", at: live.publishAt };
  if (live.privacyStatus === "private" && !live.publishAt) return { ...view, state: "unscheduled", at: null };
  return {
    ...view,
    state: "published",
    at: live.publishAt ?? (await readUpload(matchId, "video"))?.uploadedAt ?? null,
  };
}

/**
 * `PUT /api/shorts/publishat/:id` — `{ publishAt: <RFC 3339> | null, move?: true }`.
 *
 * Not on YouTube yet: stores the operator's time (null clears it, back to the next free slot);
 * the chain's upload takes it, and the Short follows 18 h later. The slot rules come back as
 * warnings, never refusals. On YouTube and scheduled: `move: true` — one explicit press, the
 * button says so — moves it there with `videos.update`, and the Short with it; it needs this
 * match's upload record (a Studio upload is moved in Studio). A time in the past (for a stored
 * one, under `MIN_LEAD_MS` away), a public video, another channel's and a Short on its own are
 * refused.
 */
export async function setPublishTime(
  matchId: number,
  body: unknown,
  nowMs = Date.now(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const no = (status: number, error: string) => ({ status, body: { error } });
  const req = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (req.kind === "short") return no(400, "a Short moves with its long-form — move the long-form");
  if (!existsSync(matchDir(matchId))) return no(404, `no working directory for match ${matchId}`);
  const later = await laterSeriesGame(matchId);
  if (later) return no(409, SERIES_LATER);
  const video = await onChannel(matchId, "video");
  // Mid-upload the time is already on its way (and the Short's is worked out from it next). After
  // the last await, so no upload can begin between this and the writes below (r3 #2).
  if (uploadRunning(matchId) || chainStep.get(matchId)?.startsWith("upload"))
    return no(409, "an upload of this match is being sent right now — once it is up, move it on YouTube");
  if (req.publishAt === null) {
    if (video) return no(409, "the video is already on YouTube — move it to a time instead");
    updateStatus(matchId, (s) => delete s.publishAt);
    shortLog(matchId, "chain", "publish time cleared — the upload takes the next free slot");
    return { status: 200, body: { publishAt: null } };
  }
  const at = typeof req.publishAt === "string" ? Date.parse(req.publishAt) : NaN;
  if (!Number.isFinite(at))
    return no(400, "expected { publishAt: a date and time, or null for the next free slot }");
  if (at <= nowMs) return no(400, "that time has passed — pick one in the future");
  const iso = new Date(at).toISOString();
  if (req.move === true) {
    if (!video) return no(409, "not on YouTube yet — Save keeps the time for the upload");
    // The Short's upload works out its time from the long-form's when it starts (r3 #3).
    if (chains.has(matchId))
      return no(409, "the Short is being made or sent right now — move it once the chain has finished");
    // Its read-reschedule-write waits out a Finish (or Put) on this match, and holds them off in
    // turn: either one's record write would otherwise put back the other's stale copy.
    return onVideo(matchId, () => moveOnYouTube(matchId, iso, nowMs));
  }
  // Pressed on a page painted before the chain uploaded: the live channel only moves on the button that says so.
  if (video) return no(409, "the video is on YouTube now — reload the page and use Move on YouTube");
  // YouTube checks the time once the whole file is up: a time minutes away can cost the upload.
  if (at <= nowMs + MIN_LEAD_MS)
    return no(
      400,
      "that is under an hour away — YouTube checks the time only once the file is up; pick a later one",
    );
  // A game after game 1 has no time of its own, and a stored one would block that hour.
  if (later === null)
    return no(
      503,
      "the playoff bracket could not be read, so whether this private-room match is a game after game 1 is unknown — try again in a minute",
    );
  updateStatus(matchId, (s) => {
    s.publishAt = iso;
  });
  const unused = unusedTime();
  const warnings = [...(unused ? [unused] : []), ...(await slotWarnings(matchId, at, nowMs))];
  shortLog(
    matchId,
    "chain",
    `publish time set to ${when(iso)}${warnings.length ? ` — ${warnings.join("; ")}` : ""}`,
  );
  return { status: 200, body: { publishAt: iso, warnings } };
}

async function moveOnYouTube(
  matchId: number,
  iso: string,
  nowMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const no = (status: number, error: string) => ({ status, body: { error } });
  // The record is what the kit, the list and the Short's time read, so a video without one (a
  // Studio upload) is moved in Studio. Whether it is still scheduled is reschedule's live read,
  // not the record's upload-time status: a video moved in Studio since still moves.
  const record = await readUpload(matchId, "video");
  if (!record) return no(409, "uploaded in Studio, with no upload record here — move it in Studio");
  const videoId = record.videoId;
  let moved;
  try {
    moved = await reschedule(videoId, iso, config.youtubeChannelId, nowMs);
  } catch (err) {
    return no(502, describeError(err));
  }
  if ("refused" in moved) return no(409, moved.refused);
  await writeUpload(matchId, { ...record, publishAt: moved.publishAt }, "video");
  // The Short keeps its standing delay behind the long-form (18 h, or the day's Short-delay
  // experiment arm — `shortPublishAt`): moved with it when it is scheduled too, and when it is
  // not up yet the chain reads the time just written.
  const shortAt = shortPublishAt({ videoId, publishAt: moved.publishAt, privacyStatus: "private" }, nowMs)!;
  const delayText = `${Math.round((shortAt.getTime() - Date.parse(moved.publishAt)) / 3600_000)} h`;
  const short = await onChannel(matchId, "short");
  let shortLine = readStatus(matchId).noShort
    ? "no Short"
    : `the Short is not up yet — it goes up for ${when(shortAt.toISOString())}, ${delayText} after`;
  if (short) {
    let failed: string;
    try {
      const s = short.videoId
        ? await reschedule(short.videoId, shortAt.toISOString(), config.youtubeChannelId, nowMs)
        : { refused: "it was ticked by hand, with no video id" };
      if ("refused" in s) failed = s.refused;
      else {
        failed = "";
        const rec = await readUpload(matchId, "short");
        if (rec) await writeUpload(matchId, { ...rec, publishAt: s.publishAt }, "short");
        shortLine = `the Short moved with it to ${when(s.publishAt)}, ${delayText} after`;
      }
    } catch (err) {
      failed = describeError(err);
    }
    if (failed) {
      // Scheduled before the long-form's new time, the Short would go public first and link a private video.
      const early =
        short.privacyStatus === "private" &&
        !!short.publishAt &&
        Date.parse(short.publishAt) > nowMs &&
        Date.parse(short.publishAt) < Date.parse(moved.publishAt);
      shortLine = `the Short did not move: ${failed}${early ? ` — it now goes out before the video (${when(short.publishAt)}); move it in Studio to ${when(shortAt.toISOString())}` : ""}`;
    }
  }
  const warnings = await slotWarnings(matchId, Date.parse(moved.publishAt), nowMs);
  const message = `YouTube ${moved.was === moved.publishAt ? "already has it" : "has it"} for ${when(moved.publishAt)}${moved.was === moved.publishAt ? "" : ` (was ${when(moved.was)})`}; ${shortLine}`;
  shortLog(matchId, "upload-video", `moved on YouTube: ${message}`);
  return { status: 200, body: { publishAt: moved.publishAt, message, warnings } };
}

/* --- The publish-slot lock ---------------------------------------------------------------------
 *
 * Four hooks saved inside one second (7 Oct 2026) started four chains whose renders all finished
 * at about the same moment, so all four reached `uploadOne` together: nothing had written a slot
 * claim yet, `claimedPublishTimes` looked empty to every one of them, and three landed on the same
 * 19:00 UTC hour. `videoPublishTime` only *reads* the disk; nothing wrote a claim until the real
 * upload's own record landed, minutes later. `claimSlot` below is the one place a chain decides
 * its slot, serialized by an in-process lock so the pick and its claim are one step: whichever
 * chain gets there first writes its slot to its own status file before the lock lets the next one
 * compute. ponytail: a promise chain, not a true mutex — fine, since every chain runs in this one
 * process and only the slot *pick* is serialized, not the slow upload that follows.
 */
let slotLock: Promise<unknown> = Promise.resolve();
function withSlotLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = slotLock.then(fn, fn);
  slotLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The long-form's publish time, claimed: an auto-picked slot is written to this match's own
 * `slotClaim` before the lock lets the next chain compute its — never the operator's own
 * `publishAt`, which is already a claim on disk before any chain runs. */
function claimSlot(matchId: number, nowMs: number): Promise<VideoPublishTime> {
  return withSlotLock(async () => {
    const t = await videoPublishTime(matchId, nowMs);
    if (!t.chosen) updateStatus(matchId, (s) => void (s.slotClaim = t.at.toISOString()));
    return t;
  });
}

async function uploadOne(matchId: number, kind: UploadKind, deps: ChainDeps): Promise<string | null> {
  let publishAt: Date | null = null;
  const notes: string[] = [];
  if (config.nightlyUpload === "scheduled") {
    if (kind === "video") {
      const t = await claimSlot(matchId, deps.now());
      if (t.passed) {
        shortLog(matchId, "chain", t.passed, { level: "warn" });
        notes.push(t.passed);
      }
      if (t.why) shortLog(matchId, "chain", `publish slot ${t.at.toISOString()}: ${t.why}`);
      // A chosen time is the operator's even when it clashes: said again at the upload, since
      // another match may have been booked into its hour since it was saved.
      if (t.chosen)
        for (const w of await slotWarnings(matchId, t.at.getTime(), deps.now())) {
          shortLog(matchId, "chain", `your time ${when(t.at.toISOString())}: ${w}`, { level: "warn" });
          notes.push(`your time ${when(t.at.toISOString())}: ${w}`);
        }
      publishAt = t.at;
    } else publishAt = shortPublishAt(await onChannel(matchId, "video"), deps.now());
  }
  if (kind === "video" && !isExported(matchId)) return NOT_EXPORTED;
  // The cold open needs the title, so it is joined here, after the save and before the upload; a
  // series video has none. A failure is a warning: the plain export goes up.
  if (kind === "video" && !existsSync(path.join(matchDir(matchId), "series.json"))) {
    const hook = hookOf((await uploadTextFor(matchId, "video")).title) ?? "";
    const failed = await deps.coldOpen(matchId, hook);
    if (failed) {
      shortLog(matchId, "chain", `no cold open: ${failed}`, { level: "warn" });
      notes.push(`no cold open: ${failed}`);
    }
  }
  const begun = await deps.upload(matchId, {
    kind,
    privacyStatus: "private",
    ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
  });
  if ("error" in begun) return begun.error;
  const done = await begun.finished;
  if (done.error) return done.error;
  // Up: the hooks lock, so the export without the cold open is never needed again.
  if (kind === "video") await rm(baseExportPath(matchDir(matchId), matchId), { force: true });
  // Up, with a post-insert problem (a playlist cap, a thumbnail): a problem on the way, not a failure.
  const step: Step = kind === "video" ? "upload-video" : "upload-short";
  if (done.warnings.length || notes.length)
    updateStatus(matchId, (s) => {
      for (const w of [...notes, ...done.warnings])
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
    // The attempt is settled either way — a real record now exists, or the slot is free to try
    // again — so `claimSlot`'s transient claim must not linger (also covers a restart's resume,
    // which never writes one itself).
    if (step === "upload-video") delete s.slotClaim;
  });
  if (error !== null) console.error(`chain #${matchId}: ${step} failed — ${error}`);
  return error === null;
}

async function advance(matchId: number, deps: ChainDeps): Promise<void> {
  const status = readStatus(matchId);
  const before = status.steps;
  // A restart leaves an upload-video/upload-short step "running" with nothing left to finish it:
  // resume its own file through `resumeUpload` rather than trusting a record, because the channel
  // scan can pair a half-uploaded video to its match long before every byte of it has landed
  // (`recordStudioUpload`) — treating that as "done" used to leave the step "running" forever.
  // `runStep` settles it done or failed either way, so the tick never resumes it a second time.
  // A long-form's mid-file failure (5xx/429/reset) keeps its session too, and the channel scan
  // pairs the half-sent video by its description link: a Save's retry must resume it, not read
  // that record as "up". (The scan never pairs a Short; the main loop's own upload resumes it.)
  for (const step of ["upload-video", "upload-short"] as const) {
    const kind: UploadKind = step === "upload-video" ? "video" : "short";
    const state = before[step]?.state;
    const cutShort =
      state === "running" ||
      (kind === "video" &&
        state !== "done" &&
        uploadsOn() &&
        !uploadRunning(matchId) &&
        (await uploadSessionOnDisk(matchId, kind)));
    if (!cutShort) continue;
    if (!(await runStep(matchId, step, () => deps.resumeUpload(matchId, kind)))) return;
    if (step === "upload-video") fastTrackUploadedHook(matchId);
  }
  // A failed upload may have reached YouTube before the record was written: a save that retries
  // it lists the channel first, or the retry would put a second copy on it.
  if (status.recheckChannel) {
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
    // Hand mode (config.shortsByHand): the session cuts the Short itself, outside the pipeline —
    // this chain never queues a pick or a render for it, and the long-form upload below runs
    // without waiting on either (pick and render are the two steps skipped here).
    if (!config.shortsByHand) {
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
      fastTrackUploadedHook(matchId);
      continue;
    }
    if (wantsShort) {
      // Hand mode: nothing on disk tells this process the files have landed once this pass ends,
      // so it is not a failure — a non-failed state on the upload-short step, no Needs-you noise
      // — just a wait. `shortTick` nudges the chain again once the long-form is up and the Short
      // still isn't, which is what notices the files once `npm run short:hand` writes them.
      if (config.shortsByHand && !shortIsReady(f)) {
        shortLog(matchId, "chain", `${WAITING_FOR_HAND_SHORT} — npm run short:hand`);
        return;
      }
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

/** Whether any match's chain is running right now — restartWhenIdle.ts's gate. */
export const chainsRunning = (): boolean => chains.size > 0;

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
      // One match's broken state (a corrupt JSON file, anything else factsOf can throw on) must
      // not starve every match ordered after it — same treatment autoHooksTick's own loop got.
      try {
        const s = readStatus(id);
        // A step recorded as running with no chain in this process: the process that ran it is gone.
        const cut = Object.entries(s.steps).find(([, st]) => st?.state === "running")?.[0];
        if (s.hooksSavedAt && !chains.has(id) && cut) {
          shortLog(id, "chain", `resumed after a restart — the ${cut} step was cut short`, { level: "warn" });
          void startChain(id, deps);
        }
        // Hand mode: a chain that stopped only because `npm run short:hand`'s files were not on
        // disk yet has nothing to tell this process when they land — unlike a render or a pick,
        // which end in a file this process itself just wrote. Nudge it every tick once the
        // long-form is up, the Short still isn't, nothing has failed and no chain or save is
        // already touching it; `advance()` is a cheap no-op when the files still aren't there.
        if (
          config.shortsByHand &&
          s.hooksSavedAt &&
          !s.noShort &&
          !chains.has(id) &&
          !saving.has(id) &&
          !hidden.has(id)
        ) {
          const failed = Object.values(s.steps).some((st) => st?.state === "failed");
          if (!failed) {
            const f = await factsOf(id);
            if (f.video && f.short === null) void startChain(id, deps);
          }
        }
        const dir = matchDir(id);
        // Hand mode never spends a model watch on a pick-retry — same reasoning as ensurePick.
        if (
          config.shortsByHand ||
          hidden.has(id) ||
          s.pickRetriedOn === utcDay(nowMs) ||
          !existsSync(pickErrorFile(dir, id))
        )
          continue;
        const f = await factsOf(id);
        // A pick under a saved hook is the operator's: never replaced behind their back. Only a
        // heuristic fallback is retried — a failed Pick again that kept the model's earlier
        // window (source "agy") is left alone; the daily retry is only for a heuristic stand-in.
        if (f.pick?.source === "heuristic" && !hooksSaved(f) && f.short === null && !pickActivity(id))
          retry.push(id);
      } catch (err) {
        console.error(`shortTick #${id}: ${describeError(err)}`);
      }
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

/* --- Auto-hooks ---------------------------------------------------------------------------------
 *
 * The operator's own grant, 8 Oct 2026: "a match whose hooks I haven't saved 6 h after its pick
 * lands gets the best title hook that passes hookProblem + hookLabelProblem + spoilsTheResult (the
 * model's, else a hooks.ts chip) and a Short hook chosen the same way; the chain then runs as if
 * I'd pressed Save." Off while `config.autoHooksAfterHours` is null; `autoHooksTick` is a no-op
 * then, so nothing here runs on a box the operator has not switched it on for.
 */

const AUTO_HOOKS_NO_PASS = "auto-hooks: no suggested hook passed the checks — save one by hand";
const AUTO_HOOKS_SYNC_HOLD =
  "auto-hooks: due, but the sync is weak and not hand-set — waiting on the sync (fix it in the sync editor and re-export, or save the hooks by hand)";

/** The pick's own age, or the file's mtime when it has none readable — a truncated or very old
 *  pick file still counts as "due", rather than ageless. Null when there is no pick file at all. */
export function pickAgeMs(
  dir: string,
  matchId: number,
  nowMs: number,
  pick: ShortPick | null,
): number | null {
  const file = pickFile(dir, matchId);
  if (!existsSync(file)) return null;
  const createdAt = pick ? Date.parse(pick.createdAt) : NaN;
  const at = Number.isFinite(createdAt) ? createdAt : statSync(file).mtimeMs;
  return nowMs - at;
}

/** Whether the operator's own saved hooks (`pastTitleHooks`) read as upper case, majority rule —
 *  so an auto-chosen hook matches the channel's house style instead of standing out as machine-made. */
export function pastHooksAreUpperCase(past: readonly { hook: string }[]): boolean {
  const lettered = past.map((p) => p.hook).filter((h) => /[a-z]/i.test(h));
  if (lettered.length === 0) return false;
  return lettered.filter((h) => h === h.toUpperCase()).length / lettered.length >= 0.5;
}

export interface AutoHooksChoice {
  titleHook: string;
  titleSource: "nicknames" | "model" | "chip";
  shortHook: string | null;
  shortSource: "model" | "chip" | null;
}

/** `choice` turned into the exact body `saveHooks` takes — upper-cased to the house style when
 *  `upper` is set, "no Short" when nothing survived for it. Pulled out of `autoSaveHooks` so the
 *  case rule and the no-Short derivation have a test that needs no network or match fixture. */
export function autoHooksBody(choice: AutoHooksChoice, upper: boolean): SaveHooksRequest {
  const titleHook = upper ? choice.titleHook.toUpperCase() : choice.titleHook;
  const shortHook =
    choice.shortHook === null ? null : upper ? choice.shortHook.toUpperCase() : choice.shortHook;
  return { titleHook, shortHook, noShort: shortHook === null };
}

/**
 * The title hook is `titleOptions.ts`'s own first option — the same one the operator is shown on
 * Telegram (18 Oct 2026) — never re-checked here: that function already holds every candidate to
 * the new rules. The Short hook is still the dashboard's own first offer (`suggestionsFor`,
 * untouched): the Short describes the moment on purpose, which is out of `titleOptions`' scope.
 * Null when nothing survived for the title (the Short may still come back null on its own: "no
 * Short hook passed" is not "no title hook passed").
 */
export async function chooseAutoHooks(
  matchId: number,
  match: MatchInfo,
  f: Facts,
): Promise<AutoHooksChoice | null> {
  const titled = await titleOptions(matchId);
  const titleHook = titled.options[0] ?? null;
  if (titleHook === null) return null;
  const suggestions = await suggestionsFor(matchId, match, f);
  const shortHook = suggestions.short[0] ?? null;
  return {
    titleHook,
    titleSource: titled.source[0] ?? "chip",
    shortHook,
    shortSource: shortHook === null ? null : shortHook === f.pick?.hookSuggestion ? "model" : "chip",
  };
}

/**
 * Lets the Telegram title picker (src/telegram/titlePicker.ts) hear every auto-hooks save, to
 * edit a pending offer message ("Auto-saved: …") if one is waiting for this match — set once at
 * that module's load, the same seam `setPicker` above is. Fire-and-forget: called after the save
 * is already written, so a broken hook here can never fail the save itself.
 */
export type AutoHooksSavedHook = (matchId: number, titleHook: string) => void;
let autoHooksSavedHook: AutoHooksSavedHook = () => {};
export const setAutoHooksSavedHook = (fn: AutoHooksSavedHook): void => {
  autoHooksSavedHook = fn;
};

/**
 * Same seam, for the Telegram fast-track ask (src/telegram/fastTrackAsk.ts): fired after every
 * match's long-form `upload-video` step settles done, on whichever path got it there (the
 * ordinary chain below or `resumeUpload`'s restart recovery) — unconditionally, same as
 * `autoHooksSavedHook` above, so this module never has to import `fastTrack.ts` (which imports
 * `nightly.ts`, which already imports this one) just to ask "was this one fast-tracked?"; the
 * hook's own implementation answers that.
 */
export type FastTrackUploadedHook = (matchId: number) => void;
let fastTrackUploadedHook: FastTrackUploadedHook = () => {};
export const setFastTrackUploadedHook = (fn: FastTrackUploadedHook): void => {
  fastTrackUploadedHook = fn;
};

/** Chooses and saves one match's hooks, exactly as `PUT /api/shorts/hooks/:id` would, and records
 *  what it chose. No candidate passing is a failed "hooks" step, not a thrown error — the match
 *  reads as failed until the operator saves one by hand, same as any other stopped step. */
async function autoSaveHooks(
  matchId: number,
  match: MatchInfo,
  f: Facts,
  deps?: Partial<ChainDeps>,
): Promise<void> {
  const choice = await chooseAutoHooks(matchId, match, f).catch((err: unknown) => {
    shortLog(matchId, "chain", `auto-hooks: could not choose a hook — ${describeError(err)}`, {
      level: "error",
    });
    return null;
  });
  // `autoHooksTick` checked this before its awaits (the facts, the match, the suggestions' user
  // lookups); the operator may have saved by hand since. Checked again with no await between here
  // and `saveHooks`' own `saving.add`, so an auto save never overwrites a typed hook, nor marks a
  // hand save's match failed with the 409 it would now get.
  const now = readStatus(matchId);
  if (
    now.hooksSavedAt ||
    now.noShort ||
    saving.has(matchId) ||
    chains.has(matchId) ||
    uploadRunning(matchId)
  ) {
    shortLog(matchId, "chain", "auto-hooks: hooks were saved by hand meanwhile — nothing auto-saved");
    return;
  }
  if (!choice) {
    updateStatus(matchId, (s) => {
      const at = new Date().toISOString();
      s.steps.hooks = { state: "failed", at, detail: AUTO_HOOKS_NO_PASS };
      s.errors.unshift({ step: "hooks", at, message: AUTO_HOOKS_NO_PASS });
    });
    shortLog(matchId, "chain", AUTO_HOOKS_NO_PASS, { level: "error" });
    return;
  }
  const upper = pastHooksAreUpperCase(pastTitleHooks());
  const req = autoHooksBody(choice, upper);
  shortLog(
    matchId,
    "chain",
    `auto-hooks: no hooks saved since the pick landed — saving title ${JSON.stringify(req.titleHook)} (${choice.titleSource})` +
      (req.noShort
        ? " and no Short (no Short hook passed the checks)"
        : ` and Short ${JSON.stringify(req.shortHook)} (${choice.shortSource})`),
  );
  const result = await saveHooks(matchId, req, deps);
  if (result && "status" in result) {
    // A refusal here (SERIES_GAME from a bracket the scan hasn't caught up to yet, a race
    // against a manual save or an upload that started in between, …) must read as a failed
    // "hooks" step like AUTO_HOOKS_NO_PASS above, or it is invisible to `gatherNeedsYou` — the
    // one place the operator said he acts from — and the next tick just tries again forever.
    const detail = `auto-hooks: save refused — ${result.error}`;
    updateStatus(matchId, (s) => {
      const at = new Date().toISOString();
      s.steps.hooks = { state: "failed", at, detail };
      s.errors.unshift({ step: "hooks", at, message: detail });
    });
    shortLog(matchId, "chain", detail, { level: "error" });
    return;
  }
  updateStatus(matchId, (s) => {
    s.autoHooks = {
      at: new Date().toISOString(),
      titleHook: req.titleHook,
      shortHook: req.shortHook,
      source: { title: choice.titleSource, short: req.noShort ? null : choice.shortSource },
    };
  });
  autoHooksSavedHook(matchId, req.titleHook);
}

let autoHooksTicking = false;

/**
 * Saves hooks by itself for every match that has gone `config.autoHooksAfterHours` hours since
 * its pick with nobody looking at it — a no-op while that setting is null. Driven by the same
 * 15-minute tick as `shortTick` (server.ts); candidates come from `listProcessedMatchIds`, same
 * as every other sweep here. `deps` is `startChain`'s own seam — a test's stand-ins for the
 * render and the upload, never a real one in production (the default `{}` takes `liveDeps()`).
 */
export async function autoHooksTick(deps: Partial<ChainDeps> = {}, nowMs = Date.now()): Promise<void> {
  const hours = config.autoHooksAfterHours;
  if (hours === null || autoHooksTicking) return;
  autoHooksTicking = true;
  try {
    const hidden = hiddenMatchIds();
    for (const matchId of listProcessedMatchIds()) {
      if (hidden.has(matchId)) continue;
      const status = readStatus(matchId);
      if (status.hooksSavedAt || status.noShort) continue;
      if (chains.has(matchId) || saving.has(matchId)) continue;
      const f = await factsOf(matchId);
      if (!f.pick || f.video || f.short) continue;
      const age = pickAgeMs(f.dir, matchId, nowMs, f.pick);
      if (age === null || age < hours * 3600_000) continue;
      const video = exportPath(f.dir, matchId);
      if (video === null || exportStale(f.dir, video).stale) continue;
      let match: MatchInfo;
      try {
        match = await getMatch(matchId);
      } catch {
        continue; // the API is down — try again next tick
      }
      const [left, right] = match.players;
      if (!left || !right || blockedIn([left.nickname, right.nickname]) || blockedOnDisk(f.dir)) continue;
      // A DNF gets no hooks (saveHooks refuses one too): skipped as quietly as a blocked match.
      if (await matchIsDnf(matchId)) continue;
      // A playoff game whose series hasn't joined yet (game 1 before the join, or game 2..n) —
      // same check `shortPlan` makes before it will even queue a pick. Its hooks are the series',
      // saved from game 1 once every game is in; saveHooks would only refuse it with SERIES_GAME,
      // forever, until the bracket catches up (shortPlan.ts's own pre-check reused here).
      if (await seriesGameUnjoined(match, f.series)) continue;
      // 14178549 (15 Oct 2026) went up ~1.4 s out of step on a 0.1 countdown read: the dashboard
      // flags a weak sync, but nobody is looking when this saves. Held, logged once, for a human.
      if (syncWeak(matchId, f)) {
        if (!status.syncHold) {
          updateStatus(matchId, (s) => {
            s.syncHold = { at: new Date().toISOString(), detail: AUTO_HOOKS_SYNC_HOLD };
          });
          shortLog(matchId, "chain", AUTO_HOOKS_SYNC_HOLD, { level: "warn" });
        }
        continue;
      }
      if (status.syncHold) updateStatus(matchId, (s) => delete s.syncHold);
      try {
        await autoSaveHooks(matchId, match, f, deps);
      } catch (err: unknown) {
        // autoSaveHooks controls its own failures internally; this is only a last-resort net so
        // one broken match directory can't abort the loop and starve every match due after it,
        // same as the getMatch guard just above.
        shortLog(matchId, "chain", `auto-hooks: ${describeError(err)}`, { level: "error" });
      }
    }
  } finally {
    autoHooksTicking = false;
  }
}

export interface AutoHooksRow {
  matchId: number;
  players: string;
  titleHook: string;
  shortHook: string | null;
  at: string;
  /** The saved title hook still reads exactly as auto-hooks left it — the operator has not edited it since. */
  stillCurrent: boolean;
  publishAt: string | null;
  /** The long-form is on the channel. */
  uploaded: boolean;
  /** The upload's own `privacyStatus` ("public", "private", "unlisted") when it has one — from
   *  upload time, not updated since (same caveat as everywhere else that reads it). Null with no
   *  upload record yet. `uploaded` alone is not "published": the chain uploads a private,
   *  scheduled draft within minutes of the Short rendering, so almost every row here has
   *  `uploaded: true` while still private. */
  privacyStatus: string | null;
}

/** Every auto-hooks save between `sinceMs` and `nowMs` — the morning report's "Auto-saved hooks" block. */
export async function listAutoHooks(sinceMs: number, nowMs = Date.now()): Promise<AutoHooksRow[]> {
  const rows: AutoHooksRow[] = [];
  for (const matchId of listProcessedMatchIds()) {
    const status = readStatus(matchId);
    const a = status.autoHooks;
    if (!a) continue;
    const at = Date.parse(a.at);
    if (!(at >= sinceMs && at <= nowMs)) continue;
    const f = await factsOf(matchId);
    const m = await matchStatusFor(matchId).catch(() => null);
    rows.push({
      matchId,
      players: m ? `${m.leftNickname} vs ${m.rightNickname}` : `#${matchId}`,
      titleHook: a.titleHook,
      shortHook: a.shortHook,
      at: a.at,
      stillCurrent: f.titleHook === a.titleHook,
      publishAt: f.video?.publishAt ?? status.slotClaim ?? status.publishAt ?? null,
      uploaded: f.video !== null,
      privacyStatus: f.video?.privacyStatus ?? null,
    });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}
