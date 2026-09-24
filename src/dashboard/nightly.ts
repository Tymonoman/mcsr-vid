/**
 * One render a night, started by the clock instead of by a click.
 *
 * The channel's bottleneck is not compute, it is operator minutes: every render is a "Render
 * this" click followed by a wait that nobody watches. The dashboard already scores
 * candidates (suggestScan.ts) and already renders on demand (jobs.ts), so the only missing piece
 * is starting the top-ranked untouched match while the lab is idle. The morning question then
 * becomes "publish this?" with a preview, rather than "render this?" with a chart.
 *
 * Deliberately timid — it starts one render (`nightlyMaxRenders`, default 1; a higher limit
 * starts the next card only after a clean run, only within four hours of the configured hour,
 * and only through these same guards), and only when nothing else is going on:
 *
 *   - it never forces a rescan. A forced scan is hundreds of feed requests against a
 *     500-per-10-minute budget; it runs the same unforced scan the timer does — the cache while
 *     fresh, only the matches played since the last scan once stale — so the pick is from
 *     tonight's feed.
 *   - it skips entirely while a pipeline is running, so an overnight render cannot land on top
 *     of one the operator started before going to bed.
 *   - it stops well before the SSD does (a finished match is 2–2.5 GB), because a render that dies
 *     at the write stage has burned the whole night for nothing.
 *
 * What it does do unprompted is encode the finished MP4 (`nightlyRenderExport`) and have the model
 * pick the Short's moment from it (src/dashboard/shortFlow.ts, queued where every export settles),
 * because a morning with a project file and no video is a morning with the publishing not started.
 * It renders no Short and uploads nothing: those wait for the operator's hooks (23 Sept 2026), and
 * the notification says how many matches are waiting for one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capacity } from "./archive.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { exportRunning, startFastExport } from "./exportRoutes.js";
import { getJob, startJob, type Job } from "./jobs.js";
import { hiddenMatchIds, nightlyQueue, setNightlyQueue } from "./matchShelf.js";
import { orderForDisplay } from "./suggestPresent.js";
import { playoffBoard, type PlayoffBoard } from "../playoffs/playoffs.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { shortRunning } from "./shortsRoutes.js";
import { nightlyShortSummary, picksIdle, shortTick } from "./shortFlow.js";
import { snapshot, startScan } from "./suggestScan.js";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";
import { retryFailedPlaylists } from "../youtube/youtubeUpload.js";
import { pickFile, type ShortPick } from "../shorts/shortPlan.js";
import { pickErrorFile } from "../shorts/videoPick.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Room for this render and one more. At ~3 GB a match, the last slot is not worth taking. */
const MIN_FREE_MATCHES = 2;

/** jobs.ts offers no completion callback, and a render runs unattended for minutes, so poll coarsely. */
const SETTLE_POLL_MS = 30_000;

/** ntfy.sh and friends answer fast or not at all; a hung POST must not outlive the render. */
const NOTIFY_TIMEOUT_MS = 10_000;

/* --- What the last run did --------------------------------------------------------------------
 *
 * One file in mediaDir records the last run, so the dashboard can show it after the log line
 * and the push notification are gone by morning. Dot-prefixed and beside `.dashboard.json` for
 * the same two reasons: the state
 * travels with the media it describes, and `listProcessedMatchIds` takes every `^\d+$`
 * *directory*, so it must not look like a match.
 *
 * Written by the same call that posts the notification, so the panel and the push can never
 * disagree about how a night went.
 */

/** `started` is written the moment a render begins; a restart mid-night leaves it as the record. */
type NightlyOutcome = "started" | "done" | "failed" | "aborted" | "skipped";
type ShortOutcome = "done" | "failed" | "skipped";

export interface NightlyLastRun {
  startedAt: string;
  /** Null when the run was skipped before it had chosen anything. */
  matchId: number | null;
  players: string[];
  outcome: NightlyOutcome;
  /** The failure's first line, or why the run was skipped. */
  reason?: string;
  /** Records from before 23 Sept 2026, when the nightly cut the Short itself. */
  short?: ShortOutcome;
  /** Who picked the Short's moment after the export: the model, or the heuristic standing in. */
  pick?: "agy" | "heuristic";
  /** The finished MP4, in the same three states. */
  export?: ShortOutcome;
}

const statePath = (): string => path.join(config.mediaDir, ".nightly.json");

/** The last recorded run, or null. Missing and corrupt are one answer, as in matchShelf.ts. */
export function readNightlyState(): NightlyLastRun | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as { lastRun?: NightlyLastRun };
    return parsed?.lastRun ?? null;
  } catch {
    // Missing is the first-ever boot and corrupt is a truncated write. Neither is worth failing
    // a status panel over, and the next run overwrites the file either way.
    return null;
  }
}

export function writeNightlyState(lastRun: NightlyLastRun): void {
  writeFileSync(statePath(), JSON.stringify({ lastRun }, null, 2));
}

/**
 * Milliseconds until the next `hourUtc:00` UTC strictly after `nowMs`.
 *
 * UTC on purpose: the lab's idle window is a wall-clock fact, but a local-time schedule would
 * silently shift by an hour twice a year, and a day is exactly 24h only in UTC.
 */
export function msUntilNextRun(nowMs: number, hourUtc: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(hourUtc, 0, 0, 0);
  const ms = next.getTime() - nowMs;
  // Landing exactly on the hour means today's run has already happened (this is the reschedule
  // at the end of one), so the next is tomorrow's — never a zero-delay timer that re-fires now.
  return ms > 0 ? ms : ms + DAY_MS;
}

/**
 * How long after the configured hour a second render may still start. Four hours: the lab is
 * idle until the morning, but a render that begins at 09:00 because the 03:00 one crawled is a
 * render competing with the operator's own dashboard, and its Short and export would run later
 * still. The window is measured from the configured hour, not from when the last run finished,
 * so a slow night narrows it by itself.
 */
const CHAIN_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Whether the night has room for another render.
 *
 * Only the count and the clock: every reason a render should not start — the disk, a render in
 * flight, nothing left to render — is re-checked by `runNightlyOnce` itself, so the second
 * render passes exactly the gate the first one did rather than a copy of it that can drift.
 *
 * A disabled schedule (`hourUtc === null`) chains nothing: the only way to get here then is the
 * dashboard's `Run now`, which is one click asking for one render.
 */
export function shouldChainNextRender(
  started: number,
  maxRenders: number,
  nowMs: number,
  hourUtc: number | null,
  windowMs: number = CHAIN_WINDOW_MS,
): boolean {
  if (started >= maxRenders || hourUtc === null) return false;
  // msUntilNextRun counts forward to the next hour and never returns 0, so a whole day minus it
  // is how long ago today's hour was.
  return DAY_MS - msUntilNextRun(nowMs, hourUtc) < windowMs;
}

interface NightlyPickContext {
  /** Match ids that already have a working directory — `listProcessedMatchIds()`. */
  processedIds: readonly number[];
  /** Ids the operator has hidden — `hiddenMatchIds()`. */
  hiddenIds: ReadonlySet<number>;
  /** Ids the operator queued, in order — `nightlyQueue()`. Rendered before the ranked pick. */
  queue?: readonly number[];
  /** `capacity().working.matchesLeft`; treat "unknown" as zero. */
  freeMatches: number;
}

/**
 * The highest-ranked suggestion worth rendering unattended, or null.
 *
 * Suggestions arrive ranked, so this only filters: anything already on disk was rendered before,
 * and re-running it overnight would spend the night reproducing files that exist; anything
 * hidden is a match the operator has already said no to.
 */
/** What a pick needs to carry: a Suggestion, or a playoff game dressed as one. */
export interface NightlyPick {
  metrics: { matchId: number; players: [string, string] };
  bucket: string;
}

/**
 * The current bracket's detected games, oldest first, as picks — ahead of every suggestion when
 * `playoffsFirst` is on. Game order is series order, which is also the playlist's.
 *
 * `playoffsFirst` is off by default and the operator turns it on for the tournament: a config
 * default that changes what tonight's render is would be a house-rule violation.
 */
export async function playoffPicks(
  board: () => Promise<PlayoffBoard> = playoffBoard,
): Promise<NightlyPick[]> {
  if (!config.playoffsFirst) return [];
  try {
    return (await board()).slots
      .flatMap((slot) =>
        slot.games.map((g) => ({
          metrics: {
            matchId: g.matchId,
            players: [slot.seeds[0].nickname, slot.seeds[1].nickname] as [string, string],
          },
          bucket: "playoffs",
          dateSec: g.dateSec,
        })),
      )
      .sort((a, b) => a.dateSec - b.dateSec);
  } catch (err) {
    // The bracket is a bonus on top of the feed, never the reason a night renders nothing.
    console.error(`nightly: playoffs unavailable — ${describeError(err)}`);
    return [];
  }
}

export async function pickNightlyCandidate<T extends { metrics: { matchId: number } }>(
  suggestions: readonly T[],
  { processedIds, hiddenIds, freeMatches, queue = [] }: NightlyPickContext,
  eligible: (candidate: T) => Promise<boolean> = async () => true,
): Promise<T | null> {
  if (freeMatches < MIN_FREE_MATCHES) return null;
  const processed = new Set(processedIds);
  // The queue is the operator's order and outranks the ranking; an id no longer on the list (the
  // VODs expired, the card was dismissed) has nothing to render and drops through.
  const queued = queue
    .map((id) => suggestions.find((s) => s.metrics.matchId === id))
    .filter((s): s is T => s !== undefined);
  for (const s of [...queued, ...suggestions]) {
    if (processed.has(s.metrics.matchId) || hiddenIds.has(s.metrics.matchId)) continue;
    // One at a time and in order: `eligible` costs API calls, and the first candidate that passes
    // is the pick, so a whole bracket is never probed to choose its first game.
    if (await eligible(s)) return s;
  }
  return null;
}

/**
 * Whether the pipeline would get past its VOD guard for this pick — asked before the night is
 * committed to it, and only of a playoff game.
 *
 * A playoff game is a private room, so the API attaches no VOD at all and both are found on
 * Twitch (`withDiscoveredVods`, the pipeline's own first step). When the players did not stream,
 * `runStages` throws *before* `matchDir` exists, so `listProcessedMatchIds` never learns the id
 * and that same game would be picked again the next night, and the next, for the whole
 * tournament. False here makes the picker fall through to the following candidate instead.
 */
const noVods = new Set<number>();

/** The playoff games this process has probed and found unstreamed, for the skip notification. */
export const playoffsWithoutVods = (): number[] => [...noVods];

export async function playoffVodsReady(
  pick: NightlyPick,
  // The probe is the pipeline's own first step, injected so the test does not shell out to yt-dlp.
  probe: (id: number) => Promise<MatchInfo> = async (id) => withDiscoveredVods(await getMatch(id)),
): Promise<boolean> {
  if (pick.bucket !== "playoffs") return true;
  const id = pick.metrics.matchId;
  // A listing is ~8 s of yt-dlp and the answer does not change: a game older than the eight
  // archives Twitch lists can never become ready, so re-probing it every night of the tournament
  // is the whole bracket's worth of delay in front of the game that would render. Only a settled
  // "they did not stream" is remembered — a failed listing is retried tomorrow.
  if (noVods.has(id)) return false;
  try {
    // getMatch is cached for ten minutes and withDiscoveredVods writes what it finds back into
    // that cache, so the download stage does not list the same archives again.
    const match = await probe(id);
    const ready = match.players.every((p) => match.vod.some((v) => v.uuid === p.uuid));
    if (!ready) {
      noVods.add(id);
      console.error(`nightly: playoff game #${id} skipped — no VOD for both players`);
    }
    return ready;
  } catch (err) {
    console.error(`nightly: playoff game #${id} skipped — ${describeError(err)}`);
    return false;
  }
}

export interface NightlyOptions {
  /** Empty string turns the notification off. */
  notifyUrl: string;
}

/**
 * The match this scheduler last started. Checked alongside every on-disk match, so a render that
 * has not yet created its working directory still counts as busy.
 */
let lastStartedId: number | null = null;

/** A pipeline, an encode or a Short on this match: the same three the delete guard refuses for. */
const busyWith = (id: number): boolean => getJob(id)?.done === false || exportRunning(id) || shortRunning(id);

const renderInFlight = (): boolean =>
  (lastStartedId !== null && busyWith(lastStartedId)) || listProcessedMatchIds().some(busyWith);

/** The notification's reminder line: "\n3 waiting for a hook", or nothing when none is. */
async function waitingLine(): Promise<string> {
  const n = (await nightlyShortSummary().catch(() => null))?.waitingForHook.length ?? 0;
  return n > 0 ? `\n${n} waiting for a hook` : "";
}

/** A failure to notify is worth a log line and nothing more — the render still happened. */
async function notify(url: string, body: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`nightly: notify failed — HTTP ${res.status}`);
  } catch (err) {
    console.error(`nightly: notify failed — ${describeError(err)}`);
  }
}

export interface JobVerdict {
  outcome: Exclude<NightlyOutcome, "skipped" | "started">;
  /** The pipeline's error text can be a multi-KB stderr tail; a notification wants a line. */
  reason?: string;
}

function outcomeOf(job: Job): JobVerdict {
  if (job.aborted) return { outcome: "aborted" };
  if (!job.error) return { outcome: "done" };
  return { outcome: "failed", reason: job.error.split("\n")[0]?.slice(0, 200) ?? "unknown" };
}

/** The clause `chainExport` returns, as the tri-state the state file records. */
const exportOutcome = (clause: string): ShortOutcome =>
  clause === "" ? "skipped" : clause === " + exported" ? "done" : "failed";

/** Starts the encode and settles with its error line, or null. Injected by the tests. */
export type ExportStarter = (matchId: number) => Promise<string | null>;

const startFastExportOf: ExportStarter = (matchId) => startFastExport(matchId).finished;

/**
 * The finished MP4 after the render, as its clause: only a clean `done`, and only when asked — a
 * match the operator will cut in Kdenlive first has no business being encoded uncut. Ten minutes
 * on the lab's VAAPI, which is why it runs at 03:00 and not at the first click of the morning.
 */
export async function chainExport(
  matchId: number,
  outcome: string,
  enabled: boolean,
  start: ExportStarter = startFastExportOf,
): Promise<string> {
  if (!enabled || outcome !== "done") return "";
  const error = await start(matchId);
  return error === null ? " + exported" : ` + export failed: ${error.slice(0, 120)}`;
}

/**
 * Match ids whose render is to be encoded as well — the nightly's pick and a card's "Render +
 * Short + MP4". A set rather than a flag on the job, because jobs.ts is the plain render path;
 * `afterSettled` consumes the entry, so two pollers on one job cannot encode twice.
 */
const wantsExport = new Set<number>();

/**
 * The pick after the export, as its clause. The export settles through `startFastExport`, which
 * queues the pick (the series' own once its last game is in); this waits for the queue and says
 * who picked. Nothing for a series game whose series is not joined yet — its pick is game 1's.
 */
export async function pickClause(matchId: number, idle: () => Promise<void> = picksIdle): Promise<string> {
  await idle();
  const file = pickFile(matchDir(matchId), matchId);
  if (!existsSync(file)) return "";
  try {
    const pick = JSON.parse(readFileSync(file, "utf8")) as ShortPick;
    if (pick.source === "agy") return " + picked by the model";
    // Why, in the push itself: "not signed in — run: …" is the one line the morning acts on.
    let why = "";
    try {
      why =
        (JSON.parse(readFileSync(pickErrorFile(matchDir(matchId), matchId), "utf8")) as { message?: string })
          .message ?? "";
    } catch {
      // No reason on disk: the clause without one.
    }
    return ` + heuristic pick (the model failed${why ? `: ${why.length > 160 ? `${why.slice(0, 159)}…` : why}` : ""})`;
  } catch {
    return "";
  }
}

export function requestExport(matchId: number): void {
  wantsExport.add(matchId);
}

/**
 * Waits out the render, encodes the MP4 if asked for, waits for the pick that follows it, and
 * reports how it all went — one notification for the lot, which is what anybody reads.
 *
 * The one poller. The nightly and "Render + Short + MP4" both land here. No Short is rendered and
 * nothing is uploaded: both wait for the operator's hooks (src/dashboard/shortFlow.ts).
 */
export function afterSettled(
  job: Job,
  report?: (verdict: JobVerdict, exportClause: string, pickClause: string) => Promise<void> | void,
): void {
  const poll = () => void tick().catch((err: unknown) => console.error(`nightly: ${describeError(err)}`));
  const tick = async (): Promise<void> => {
    if (!job.done) {
      setTimeout(poll, SETTLE_POLL_MS);
      return;
    }
    const verdict = outcomeOf(job);
    const exportClause = await chainExport(job.matchId, verdict.outcome, wantsExport.delete(job.matchId));
    const picked = exportOutcome(exportClause) === "done" ? await pickClause(job.matchId) : "";
    await report?.(verdict, exportClause, picked);
  };
  poll();
}

export interface NightlyRunResult {
  matchId?: number;
  players?: string[];
  /** Why nothing was started, when nothing was. */
  skipped?: string;
  /** True for the one skip that is a conflict rather than an answer — something is rendering. */
  busy?: boolean;
}

/** The seams the tests inject: the two things `runNightlyOnce` cannot reach without a live lab. */
export interface NightlyDeps {
  renderInFlight: () => boolean;
  /** The ranked list to pick from, or null when there is none. */
  ranked: () => Promise<readonly NightlyPick[] | null>;
}

const liveRanked = async (): Promise<readonly NightlyPick[] | null> => {
  // Not `startScan(true)`: a forced rescan is hundreds of API requests. Unforced, the scan
  // returns the cache while it is fresh and walks only the matches played since the last one
  // when it is stale — so the pick is from tonight's feed, not from whenever the process booted.
  await startScan(false);
  const result = snapshot().result;
  return result ? [...(await playoffPicks()), ...orderForDisplay(result.suggestions)] : null;
};

/** The disk-and-shelf half of the pick, shared by the run and the dashboard's preview of it. */
const pickContext = async (): Promise<NightlyPickContext> => ({
  processedIds: listProcessedMatchIds(),
  hiddenIds: hiddenMatchIds(),
  queue: nightlyQueue(),
  // A missing capacity reading (statfs failed, mediaDir gone) is not a licence to fill a disk.
  freeMatches: (await capacity()).working?.matchesLeft ?? 0,
});

/**
 * What a run right now would start, without starting it — the dashboard's preview.
 *
 * Deliberately never scans: a GET the browser polls must not be able to spend a scan's worth of
 * the MCSR request budget. No cached list simply means nothing to promise yet.
 */
export async function nightlyCandidate(): Promise<NightlyPick | null> {
  const result = snapshot().result;
  return result
    ? // No VOD probe: a GET the browser polls must not spend a yt-dlp listing per candidate. The
      // preview may therefore name a game the run itself falls through — it is a preview.
      pickNightlyCandidate(
        [...(await playoffPicks()), ...orderForDisplay(result.suggestions)],
        await pickContext(),
      )
    : null;
}

/**
 * One nightly run, from the guards to the notification.
 *
 * Split out of the timer callback so the route and the clock invoke the same body: the chain had
 * never once run end to end, and "wait until 03:00 UTC" is not a way to test it. Nothing here
 * touches the schedule, so a manual run leaves tonight's alone.
 */
export async function runNightlyOnce(
  notifyUrl: string,
  deps: Partial<NightlyDeps> = {},
  /** Which render of the night this is; `nightlyMaxRenders` is the last one. */
  started = 1,
): Promise<NightlyRunResult> {
  const { renderInFlight: busy = renderInFlight, ranked = liveRanked } = deps;
  const startedAt = new Date().toISOString();
  const skip = async (reason: string, conflict = false): Promise<NightlyRunResult> => {
    console.error(`nightly: skipped — ${reason}`);
    // A conflict is the one skip that is not an outcome: the route answers it 409 and the run
    // already in flight is what the night produced. Recording it would replace last night's
    // real result with "skipped" on the strip — and a push for it would wake nobody usefully.
    // Neither is a chained run's skip, and that one is the common case: a match is 2–2.5 GB, so
    // the render that just finished is usually what drops `freeMatches` under the guard. The
    // night's outcome is the render this run was chained from, which has already written its
    // "done" and pushed for it; recording this would put "skipped" over it.
    if (!conflict && started === 1) {
      writeNightlyState({ startedAt, matchId: null, players: [], outcome: "skipped", reason });
      if (notifyUrl) await notify(notifyUrl, `Nightly skipped — ${reason}${await waitingLine()}`);
    }
    return { skipped: reason, ...(conflict ? { busy: true } : {}) };
  };

  if (busy()) return skip("a render is already in flight", true);

  const suggestions = await ranked();
  if (!suggestions) return skip("no suggestions available");

  const pick = await pickNightlyCandidate(suggestions, await pickContext(), playoffVodsReady);
  if (!pick) {
    // Naming them: a bracket whose players stream on someone else's channel would otherwise
    // produce nothing but "nothing to render" for a fortnight, with the reason only in the log.
    const unstreamed = playoffsWithoutVods();
    return skip(
      "every candidate is processed, hidden or without VODs, or the disk is full" +
        (unstreamed.length ? ` (no VOD: ${unstreamed.map((id) => `#${id}`).join(", ")})` : ""),
    );
  }
  // Checked again after the awaits above: a render clicked while the list was being ranked
  // must not get a second one started on top of it.
  if (busy()) return skip("a render is already in flight", true);

  const { matchId, players } = pick.metrics;
  const label = `${players[0]} vs ${players[1]}`;
  console.error(`nightly: starting render of #${matchId} ${label}`);
  lastStartedId = matchId;
  // A queue entry is one night's work: out of the list the moment its render starts.
  setNightlyQueue(nightlyQueue().filter((id) => id !== matchId));
  if (config.nightlyRenderExport) requestExport(matchId);
  // The same call `POST /api/render` makes, so a nightly render and a clicked one are one code
  // path: startJob de-duplicates by match id and owns the whole pipeline invocation.
  const job = startJob(matchId);
  // Recorded now, so a restart mid-render leaves "started" on the strip rather than nothing.
  writeNightlyState({ startedAt, matchId, players: [...players], outcome: "started" });
  afterSettled(job, async (verdict, exportClause, picked) => {
    // State first, then the push, from the same values: a panel that disagreed with the
    // notification would be worse than either on its own.
    writeNightlyState({
      startedAt,
      matchId,
      players: [...players],
      outcome: verdict.outcome,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      export: exportOutcome(exportClause),
      ...(picked ? { pick: picked.startsWith(" + picked") ? "agy" : "heuristic" } : {}),
    });
    const said = verdict.reason ? `${verdict.outcome}: ${verdict.reason}` : verdict.outcome;
    if (notifyUrl) {
      await notify(
        notifyUrl,
        `Rendered #${matchId} ${label} — ${said}${exportClause}${picked}${await waitingLine()}`,
      );
    }
    // A lab that finished at 04:30 is idle for the rest of the night, and the operator's morning
    // is the bottleneck this scheduler exists to widen. The next card goes through the whole of
    // this function again — the scan, the disk check, the busy check — so nothing that stops the
    // first render can be skipped by the second. Only a clean run earns one, as the Short and
    // the export do; the state file then describes the later render, which is the one still
    // worth acting on.
    if (
      verdict.outcome === "done" &&
      shouldChainNextRender(started, config.nightlyMaxRenders, Date.now(), config.nightlyRenderHourUtc)
    ) {
      await runNightlyOnce(notifyUrl, deps, started + 1);
    }
  });
  return { matchId, players: [...players] };
}

let nightlyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arms the nightly render and re-arms it after every run. Never throws: a scheduler that dies on
 * one bad night is worse than one that logs and tries again tomorrow.
 *
 * The hour is read from `config` on every arm rather than captured, so the settings panel can
 * move it — or switch the nightly off — without a restart. Calling this again replaces the
 * pending timer, which is what makes it safe as a re-arm: two timers would render twice.
 */
export function scheduleNightly(options: NightlyOptions): void {
  if (nightlyTimer) clearTimeout(nightlyTimer);
  nightlyTimer = null;
  const hourUtc = config.nightlyRenderHourUtc;
  if (hourUtc === null) {
    console.error("nightly: disabled (nightlyRenderHourUtc is null)");
    return;
  }
  const delay = msUntilNextRun(Date.now(), hourUtc);
  console.error(`nightly: next auto-render at ${new Date(Date.now() + delay).toISOString()}`);
  nightlyTimer = setTimeout(() => {
    // The daily tick is also the press that clears a playlist step YouTube's creation cap refused
    // (src/youtube/youtubeUpload.ts); it is not part of the run so a skipped night still makes it.
    retryFailedPlaylists().catch((err: unknown) => console.error(`playlists: ${describeError(err)}`));
    // And the tick that asks the model again for a pick the heuristic stood in for.
    shortTick().catch((err: unknown) => console.error(`shorts: ${describeError(err)}`));
    runNightlyOnce(options.notifyUrl)
      .catch((err: unknown) => console.error(`nightly: ${describeError(err)}`))
      .finally(() => scheduleNightly(options));
  }, delay);
}

/** When the armed run is due, or null when nothing is armed. For the settings panel to state. */
export const nightlyArmedAtMs = (): number | null =>
  config.nightlyRenderHourUtc === null
    ? null
    : Date.now() + msUntilNextRun(Date.now(), config.nightlyRenderHourUtc);
