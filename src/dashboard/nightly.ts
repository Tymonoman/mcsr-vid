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
import { archiveMatch, capacity, inNasWindow, refreshArchived } from "./archive.js";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { writeExperimentArmFile } from "./experiments.js";
import { anyExportRunning, exportRunning, startFastExport } from "./exportRoutes.js";
import { anyJobRunning, getJob, startJob, type Job } from "./jobs.js";
import {
  hiddenMatchIds,
  nightlyQueue,
  nightlySkipIds,
  setNightlyQueue,
  setSkipNightOf,
  skipNightOf,
} from "./matchShelf.js";
import { refreshPairPosts } from "./pairPosts.js";
import { orderForDisplay } from "./suggestPresent.js";
import { dnfRefusal, matchIsDnf, playoffBoard, type PlayoffBoard } from "../playoffs/playoffs.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { shortRunning } from "./shortsRoutes.js";
import { anyThumbnailRunning, thumbnailRunning } from "../thumbnails/rerender.js";
import { nightlyShortSummary, picksIdle, shortTick } from "./shortFlow.js";
import { snapshot, startScan } from "./suggestScan.js";
import { knownTierFor, pooledMatchPlayers, scanKnowledge } from "./suggest.js";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";
import { retryFailedPlaylists, retryPendingComments, retryPendingStudio } from "../youtube/youtubeUpload.js";
import { allUploads } from "../youtube/youtubeStore.js";
import { pickFile, type ShortPick } from "../shorts/shortPlan.js";
import { pickErrorFile } from "../shorts/videoPick.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Room for this render and one more. At ~3 GB a match, the last slot is not worth taking. Exported
 * for the Telegram morning report (src/telegram/facts.ts), which names the same guard rather than
 * carrying its own copy of the number.
 */
export const MIN_FREE_MATCHES = 2;

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
  /** Ids the operator opted out of nightly rendering — `nightlySkipIds()`. */
  skipIds?: ReadonlySet<number>;
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
  /** `dnf` as its source read it: a suggestion's own scoring, a queued id's `matchIsDnf`. */
  metrics: { matchId: number; players: [string, string]; dnf?: boolean };
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
    return (
      (await board()).slots
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
        // A blocked seed's games too, same as any other candidate (config.blockedPlayers).
        .filter((pick) => !blockedIn(pick.metrics.players))
        .sort((a, b) => a.dateSec - b.dateSec)
    );
  } catch (err) {
    // The bracket is a bonus on top of the feed, never the reason a night renders nothing.
    console.error(`nightly: playoffs unavailable — ${describeError(err)}`);
    return [];
  }
}

export async function pickNightlyCandidate<T extends { metrics: { matchId: number } }>(
  suggestions: readonly T[],
  { processedIds, hiddenIds, skipIds = new Set(), freeMatches, queue = [] }: NightlyPickContext,
  eligible: (candidate: T) => Promise<boolean> = async () => true,
  /**
   * A queued id missing from `suggestions` (a later scan trimmed it off the ranked list): resolved
   * here rather than dropped, so the operator's own pick cannot go silently empty. The default gives
   * up exactly as before this existed; the live one is `resolveQueuedPick`, injected by the two
   * callers that build a real `T` (`runNightlyOnce`, `nightlyCandidate`).
   */
  resolveMissing: (id: number) => Promise<T | null> = async () => null,
): Promise<T | null> {
  if (freeMatches < MIN_FREE_MATCHES) return null;
  const processed = new Set(processedIds);
  // The queue is the operator's order and outranks the ranking; an id no longer on the list (the
  // VODs expired, the card was dismissed) has nothing to render and drops through.
  const queuedMatchIds = new Set(queue);
  const queued: T[] = [];
  for (const id of queue) {
    const found = suggestions.find((s) => s.metrics.matchId === id) ?? (await resolveMissing(id));
    if (found !== null) queued.push(found);
  }
  for (const s of [...queued, ...suggestions]) {
    const id = s.metrics.matchId;
    if (processed.has(id) || hiddenIds.has(id)) continue;
    // An explicit queue wins over nightlySkip; otherwise, skip ids opted out by the operator.
    if (skipIds.has(id) && !queuedMatchIds.has(id)) continue;
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

/**
 * Whether a pick is a player people know: a playoff game always is (the bracket's players are the
 * season's top 16, and their Twitch following is often unmeasured — a missing follower count must
 * not gate out a game that is on the board precisely because it is worth watching), otherwise at
 * least one player clears `knownTierFor` (favourite, measured draw, or Twitch followers). Reads the
 * scan's own cache (`scanKnowledge`), so this costs no API call of its own.
 */
export function isKnownPick(pick: NightlyPick): boolean {
  if (pick.bucket === "playoffs") return true;
  const known = knownTierFor(
    config.favouritePlayers,
    (name) => scanKnowledge().twitchOf(name)?.followers ?? null,
    config.knownFollowerThreshold,
  );
  return known(pick.metrics.players);
}

/**
 * Whether a pick is worth an unattended render: findable VODs (a playoff game only —
 * `playoffVodsReady` is a no-op for anything else) and, unless the operator queued it themself, a
 * known player (`isKnownPick`). The queue always wins, the same as it already wins over
 * `nightlySkip` — the operator's own pick is never second-guessed by a gate meant for the ranked
 * list (1 Oct 2026, the operator: "the suggestion system is shit it recommends and schedules matches
 * that no one will watch").
 */
export function nightlyEligible(
  queue: readonly number[],
  checkVods: (pick: NightlyPick) => Promise<boolean> = playoffVodsReady,
): (pick: NightlyPick) => Promise<boolean> {
  const queued = new Set(queue);
  // Checked before the queue, not after: a blocked match is never rendered, however it got here —
  // the operator's own queue does not override this the way it overrides nightlySkip and the
  // known-player gate (config.blockedPlayers). Nor is a DNF (`finishedPick`).
  return async (pick) =>
    !blockedIn(pick.metrics.players) &&
    finishedPick(pick) &&
    (await checkVods(pick)) &&
    (queued.has(pick.metrics.matchId) || isKnownPick(pick));
}

/**
 * Not a DNF (nobody finished), as the pick's source read it — no API call here. The ranked list is
 * DNF-free already (suggest.ts); the case is a queued id (`resolveQueuedPick`). Logged, queued or
 * not; the queue entry stays, the operator's to remove (the morning report's Needs-you names it).
 * A playoff pick carries no flag: the board offers no series whose every game is a DNF, and a
 * forfeited game among finished ones renders for its series.
 */
export function finishedPick(pick: NightlyPick): boolean {
  if (pick.metrics.dnf !== true) return true;
  const id = pick.metrics.matchId;
  console.error(`nightly: #${id} skipped — ${dnfRefusal(id, "never rendered, queued or not")}`);
  return false;
}

/** A queued id from the scan's own pool, or null — no API call (the preview's whole resolver). */
export function pooledQueuedPick(id: number): NightlyPick | null {
  const players = pooledMatchPlayers(id);
  return players ? { metrics: { matchId: id, players }, bucket: "queued" } : null;
}

/**
 * A queued id `take()`'s slots have since dropped (a later scan trimmed the ranked list; the operator's
 * pick must not go silently empty for it): the scan's own pool first, no API call; failing that, one
 * `getMatch` and the scan's own scoring (`computeMetrics`) — at most one request per such id. A match
 * this cannot even read is skipped, logged, and left for the next scan to resolve.
 */
export async function resolveQueuedPick(id: number): Promise<NightlyPick | null> {
  const pooled = pooledQueuedPick(id);
  if (pooled) return blockedIn(pooled.metrics.players) ? null : pooled;
  try {
    const match = await getMatch(id);
    const players = computeMetrics(match).players;
    if (blockedIn(players)) return null;
    // Resolved rather than dropped, so `finishedPick` says why it is skipped. A pooled DNF never
    // reaches here as one (`pooledMatchPlayers` leaves it out).
    const dnf = await matchIsDnf(id, async () => match);
    return { metrics: { matchId: id, players, ...(dnf ? { dnf } : {}) }, bucket: "queued" };
  } catch (err) {
    console.error(`nightly: queued #${id} could not be read — ${describeError(err)}`);
    return null;
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

/**
 * True from the first render of a night's chain (`nightlyMaxRenders` > 1 can mean several) until
 * the last one has either started nothing or settled its last job. `renderInFlight`/`anyJobRunning`/
 * `anyExportRunning` all read false in the gap between two chained renders — this function is
 * awaiting the suggestion scan and `pickContext` for the next one, which can themselves be
 * network-bound — so `restartWhenIdle.ts`'s `idle()` reads this too, or a restart armed during the
 * day could land in that gap and silently drop the rest of the night's chain (review fix, 8 Oct 2026).
 *
 * A count of chains, not one flag: a Run now answered 409 while the scheduled chain is in flight
 * (or the 03:00 timer firing during a Run now chain) starts and ends a chain of its own, and with
 * one boolean that ending wiped the other chain's ownership (14 Oct 2026).
 */
let chainsActive = 0;
export const nightlyChainRunning = (): boolean => chainsActive > 0;
const endChain = (): void => {
  chainsActive = Math.max(0, chainsActive - 1);
};

/** A pipeline, an encode, a Short or a thumbnail re-render on this match: the same four the delete guard refuses for. */
const busyWith = (id: number): boolean =>
  getJob(id)?.done === false || exportRunning(id) || shortRunning(id) || thumbnailRunning(id);

/**
 * True while a scheduled run is on its way to `startJob`. The thumbnails' bulk re-render
 * (thumbnailRoutes.ts) holds its next match while this is set, and the run waits out the
 * re-render in flight rather than skipping the night for a job of a minute or two.
 */
let starting = false;
export const nightlyStarting = (): boolean => starting;
/** One match's four stills take a minute or two; the scheduled run waits this long at most. */
const THUMBNAIL_WAIT_MS = 20 * 60_000;

// Any pipeline at all, not only one with a directory: a render clicked elsewhere (or a series run's
// next game) has none until fetch-match and VOD discovery finish. `busyWith` still adds the export,
// Short and thumbnail work on a match that has one.
const renderInFlight = (): boolean =>
  anyJobRunning() ||
  (lastStartedId !== null && busyWith(lastStartedId)) ||
  listProcessedMatchIds().some(busyWith);

/** The notification's reminder line: "\n3 waiting for a hook", or nothing when none is. */
async function waitingLine(): Promise<string> {
  const summary = await nightlyShortSummary().catch((err) => {
    console.error(`nightly: waiting-for-hook summary failed — ${describeError(err)}`);
    return null;
  });
  const n = summary?.waitingForHook.length ?? 0;
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
  } catch (err) {
    // Distinct from "no pick file exists yet" above (which returns the same empty clause by
    // design): this is a pick file that exists but didn't parse, and must not look identical.
    console.error(`nightly: pick file for #${matchId} unreadable — ${describeError(err)}`);
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
  /** Whether this execution is the scheduled nightly run (as opposed to Run now). Default false. */
  scheduled: boolean;
  /** Mock clock for testing. Default Date.now. */
  now: () => number;
  /** A queued id missing from the ranked list: `resolveQueuedPick` by default, a real `getMatch` away. */
  resolveQueued: (id: number) => Promise<NightlyPick | null>;
  /** How long a scheduled run waits out a thumbnail re-render. Default 20 min. */
  thumbnailWaitMs: number;
}

/** How long the nightly waits for the pairs the channel put out lately before it picks without them. */
export const PAIR_POSTS_WAIT_MS = 15_000;

/**
 * `refreshPairPosts`, but never held for longer than `waitMs`. The names it needs are asked for one
 * at a time through a fetch with no timeout, so a stalled API would otherwise hold the unattended
 * 03:00 pick for minutes. Past the deadline the pick uses the last snapshot and the refresh carries
 * on in the background; a refresh that fails settles it too, and nothing here ever rejects.
 */
export function refreshPairPostsWithin(
  waitMs: number = PAIR_POSTS_WAIT_MS,
  refresh: () => Promise<void> = () => refreshPairPosts(),
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `nightly: the pairs the channel put out lately took over ${waitMs / 1000} s — picking with the last answer`,
      );
      resolve();
    }, waitMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    void refresh().then(done, done);
  });
}

const liveRanked = async (): Promise<readonly NightlyPick[] | null> => {
  // Not `startScan(true)`: a forced rescan is hundreds of API requests. Unforced, the scan
  // returns the cache while it is fresh and walks only the matches played since the last one
  // when it is stale — so the pick is from tonight's feed, not from whenever the process booted.
  await startScan(false);
  const result = snapshot().result;
  // The pairs the channel put out lately, fresh: the order demotes a repeat (src/dashboard/pairPosts.ts).
  await refreshPairPostsWithin();
  return result ? [...(await playoffPicks()), ...orderForDisplay(result.suggestions)] : null;
};

/** YYYY-MM-DD in UTC of the next scheduled nightly run, or null when nightly is disabled. */
export function nextScheduledRunDateUtc(
  nowMs: number = Date.now(),
  hourUtc: number | null = config.nightlyRenderHourUtc,
): string | null {
  if (hourUtc === null) return null;
  const nextMs = nowMs + msUntilNextRun(nowMs, hourUtc);
  return new Date(nextMs).toISOString().slice(0, 10);
}

/** The disk-and-shelf half of the pick, shared by the run and the dashboard's preview of it. */
export const pickContext = async (): Promise<NightlyPickContext> => {
  const queue = nightlyQueue();
  return {
    // A queued id whose directory holds no project yet (creator watch's vods.json, a download-vods
    // prefetch) has not been rendered: counted as processed, the operator's pick would drop
    // through every night until its VODs expire.
    processedIds: listProcessedMatchIds().filter(
      (id) => !queue.includes(id) || existsSync(path.join(matchDir(id), `match-${id}.kdenlive`)),
    ),
    hiddenIds: hiddenMatchIds(),
    skipIds: nightlySkipIds(),
    queue,
    // A missing capacity reading (statfs failed, mediaDir gone) is not a licence to fill a disk.
    freeMatches: (await capacity()).working?.matchesLeft ?? 0,
  };
};

/**
 * What a run right now would start, without starting it — the dashboard's preview.
 *
 * Deliberately never scans: a GET the browser polls must not be able to spend a scan's worth of
 * the MCSR request budget. No cached list simply means nothing to promise yet.
 */
export async function nightlyCandidate(): Promise<NightlyPick | null> {
  const result = snapshot().result;
  // Only a kick, never awaited: a read of the records (and, for a new upload, one API request) is not
  // something a polled GET waits for. The preview uses what the last refresh found.
  void refreshPairPosts();
  if (!result) return null;
  return previewPick(
    [...(await playoffPicks()), ...orderForDisplay(result.suggestions)],
    await pickContext(),
  );
}

/**
 * The preview's pick from a ranked list. No VOD probe: a GET the browser polls must not spend a
 * yt-dlp listing per candidate, so the preview may name a game the run itself falls through. The
 * known gate is cheap (the scan's own cache) and applies. A queued id off the list shows only from the
 * scan's pool (`pooledQueuedPick`), else it is left out: only `runNightlyOnce` may spend a `getMatch`
 * on it — a polled GET never touches the network for one.
 */
export function previewPick(
  ranked: readonly NightlyPick[],
  ctx: NightlyPickContext,
): Promise<NightlyPick | null> {
  return pickNightlyCandidate(
    ranked,
    ctx,
    nightlyEligible(ctx.queue ?? [], async () => true),
    async (id) => pooledQueuedPick(id),
  );
}

/**
 * Queues `archiveMatch` for every uploaded match the NAS does not have yet — the periodic pass
 * that catches an upload whose automatic copy was deferred to the quiet window (or missed for
 * any other reason), with no click from the operator. Gated on the window itself, not just on
 * each `archiveMatch` call it makes: "Run now" at 14:00 must not list every match and print a
 * deferred line for each one. `now` is threaded into every `archiveMatch` call so a long queue's
 * own re-check (src/dashboard/archive.ts) sees the same clock this gate did.
 */
export async function sweepArchive(
  now: () => number = Date.now,
  archive: (matchId: number, now: () => number) => void = archiveMatch,
): Promise<void> {
  if (!inNasWindow(now())) return;
  for (const { matchId } of await allUploads()) {
    if (!refreshArchived(matchId)) archive(matchId, now);
  }
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
  if (!deps.scheduled) return runOnce(notifyUrl, deps, started);
  starting = true;
  try {
    // Bounded: a re-render still running past this is a recorded, notified skip below, and the
    // timer re-arms for tomorrow rather than waiting on it for ever.
    const until = Date.now() + (deps.thumbnailWaitMs ?? THUMBNAIL_WAIT_MS);
    while (anyThumbnailRunning() && Date.now() < until) await new Promise((r) => setTimeout(r, 1_000));
    return await runOnce(notifyUrl, deps, started);
  } finally {
    starting = false;
  }
}

async function runOnce(
  notifyUrl: string,
  deps: Partial<NightlyDeps>,
  started: number,
): Promise<NightlyRunResult> {
  const {
    renderInFlight: busy = renderInFlight,
    ranked = liveRanked,
    scheduled = false,
    now = () => Date.now(),
    resolveQueued = resolveQueuedPick,
  } = deps;
  const startedAt = new Date(now()).toISOString();

  // Set once, at the chain's very first call, and cleared at every point below where this
  // function settles without a job left running or about to be chained from — see `chainsActive`.
  if (started === 1) chainsActive++;
  try {
    return await runNightlyOnceInner();
  } catch (err) {
    endChain();
    throw err;
  }

  async function runNightlyOnceInner(): Promise<NightlyRunResult> {
    // Independent of whether tonight renders anything, so it still runs on "Run now" and on a
    // night that skips below — but only once a night, and `sweepArchive` is itself a no-op outside
    // the window, so a daytime "Run now" does not even list every match. Never fails the run.
    if (started === 1) {
      try {
        await sweepArchive(now);
      } catch (err) {
        console.error(`nightly: NAS sweep failed — ${describeError(err)}`);
      }
    }

    // The scheduled run whose date matches does nothing but log/notify one line, then clears.
    // "Run now" ignores skipNightOf.
    if (scheduled && started === 1) {
      const skipDate = skipNightOf();
      const todayUtc = new Date(now()).toISOString().slice(0, 10);
      if (skipDate === todayUtc) {
        setSkipNightOf(null);
        console.error("nightly: skipped by the operator");
        writeNightlyState({
          startedAt,
          matchId: null,
          players: [],
          outcome: "skipped",
          reason: "skipped by the operator",
        });
        if (notifyUrl) await notify(notifyUrl, "skipped by the operator");
        endChain();
        return { skipped: "skipped by the operator" };
      }
    }

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
      // Whatever level of the chain this is, nothing further will start from this call —
      // the chain (this call's branch of it) is over.
      endChain();
      return { skipped: reason, ...(conflict ? { busy: true } : {}) };
    };

    // The scheduled run has already waited this out (runNightlyOnce). Still running, it is hung, and
    // the night it costs is an outcome to record and push — not the conflict below, which says
    // nothing to anyone because a render in flight is the night's work.
    if (scheduled && anyThumbnailRunning()) return skip("a thumbnail re-render is still running");
    const inFlight = () =>
      anyThumbnailRunning() ? "a thumbnail re-render is running" : "a render is already in flight";
    if (busy()) return skip(inFlight(), true);

    const suggestions = await ranked();
    if (!suggestions) return skip("no suggestions available");

    const ctx = await pickContext();
    const pick = await pickNightlyCandidate(
      suggestions,
      ctx,
      nightlyEligible(ctx.queue ?? []),
      resolveQueued,
    );
    if (!pick) {
      // Naming them: a bracket whose players stream on someone else's channel would otherwise
      // produce nothing but "nothing to render" for a fortnight, with the reason only in the log.
      const unstreamed = playoffsWithoutVods();
      return skip(
        "every candidate is processed, hidden, without VODs or has no known player, or the disk is full" +
          (unstreamed.length ? ` (no VOD: ${unstreamed.map((id) => `#${id}`).join(", ")})` : ""),
      );
    }
    // Checked again after the awaits above: a render clicked while the list was being ranked
    // must not get a second one started on top of it.
    if (busy()) return skip(inFlight(), true);

    const { matchId, players } = pick.metrics;
    const label = `${players[0]} vs ${players[1]}`;
    console.error(`nightly: starting render of #${matchId} ${label}`);
    lastStartedId = matchId;
    // A no-op unless today's UTC date has a schedule entry (src/dashboard/experiments.ts) — the
    // render's own arm settings were already applied by `applyScheduledRenderArm` closer to this
    // hour; this just leaves a record of which arm they were in the match directory.
    writeExperimentArmFile(matchId, now());
    // A queue entry is one night's work: out of the list the moment its render starts.
    setNightlyQueue(nightlyQueue().filter((id) => id !== matchId));
    if (config.nightlyRenderExport) requestExport(matchId);
    // The same call `POST /api/render` makes, so a nightly render and a clicked one are one code
    // path: startJob de-duplicates by match id and owns the whole pipeline invocation.
    const job = startJob(matchId);
    // Recorded now, so a restart mid-render leaves "started" on the strip rather than nothing.
    writeNightlyState({ startedAt, matchId, players: [...players], outcome: "started" });
    afterSettled(job, async (verdict, exportClause, picked) => {
      // Ended exactly once here unless handed on: a count that leaked would hold off a restart for ever.
      let chained = false;
      try {
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
          // The chain stays counted across this call — the chained call owns its end now (its
          // skip, its own "not chaining further", or runOnce's catch if it blew up starting).
          chained = true;
          try {
            await runNightlyOnce(notifyUrl, deps, started + 1);
          } catch (err) {
            console.error(`nightly: chained render failed to start — ${describeError(err)}`);
          }
        }
      } finally {
        if (!chained) endChain();
      }
    });
    return { matchId, players: [...players] };
  }
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
    // And posts the first comment on a scheduled video once it goes public.
    retryPendingComments().catch((err: unknown) => console.error(`comments: ${describeError(err)}`));
    // And pins it through Studio automation (config.studioAutomation; a no-op while it's off) —
    // skipped outright while an export is running, since Chrome and ffmpeg share this box's four cores.
    if (!anyExportRunning())
      retryPendingStudio().catch((err: unknown) => console.error(`studio: ${describeError(err)}`));
    // And the tick that asks the model again for a pick the heuristic stood in for.
    shortTick().catch((err: unknown) => console.error(`shorts: ${describeError(err)}`));
    runNightlyOnce(options.notifyUrl, { scheduled: true })
      .catch((err: unknown) => console.error(`nightly: ${describeError(err)}`))
      .finally(() => scheduleNightly(options));
  }, delay);
}

/** When the armed run is due, or null when nothing is armed. For the settings panel to state. */
export const nightlyArmedAtMs = (): number | null =>
  config.nightlyRenderHourUtc === null
    ? null
    : Date.now() + msUntilNextRun(Date.now(), config.nightlyRenderHourUtc);
