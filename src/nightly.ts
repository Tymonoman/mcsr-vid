/**
 * One render a night, started by the clock instead of by a click.
 *
 * The channel's bottleneck is not compute, it is operator minutes: every render is a "Render
 * this" click followed by a wait that nobody watches. The dashboard already scores
 * candidates (suggestScan.ts) and already renders on demand (jobs.ts), so the only missing piece
 * is starting the top-ranked untouched match while the lab is idle. The morning question then
 * becomes "publish this?" with a preview, rather than "render this?" with a chart.
 *
 * Deliberately timid — it starts *one* render, and only when nothing else is going on:
 *
 *   - it never forces a rescan. A forced scan is hundreds of feed requests against a
 *     500-per-10-minute budget, and the cached list is what the operator would be picking from
 *     anyway; a scan happens only when there is no list at all yet.
 *   - it skips entirely while a pipeline is running, so an overnight render cannot land on top
 *     of one the operator started before going to bed.
 *   - it stops well before the SSD does (a finished match is 2–2.5 GB), because a render that dies
 *     at the write stage has burned the whole night for nothing.
 *
 * What it does do unprompted is cut the Short of the match it just rendered (`nightlyRenderShort`)
 * and encode the finished MP4 (`nightlyRenderExport`), because that is the same footage, already
 * on disk, and a morning with a project file and no video is a morning with the publishing not
 * started.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { capacity } from "./archive.js";
import { config, matchDir } from "./config.js";
import { describeError } from "./errorText.js";
import { startFastExport } from "./exportRoutes.js";
import { getJob, startJob, type Job } from "./jobs.js";
import { hiddenMatchIds } from "./matchShelf.js";
import { orderForDisplay } from "./suggestPresent.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { spawnShortJob, type ShortRunner } from "./shortsRoutes.js";
import type { Suggestion } from "./suggest.js";
import { snapshot, startScan } from "./suggestScan.js";

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

type NightlyOutcome = "done" | "failed" | "aborted" | "skipped";
type ShortOutcome = "done" | "failed" | "skipped";

export interface NightlyLastRun {
  startedAt: string;
  /** Null when the run was skipped before it had chosen anything. */
  matchId: number | null;
  players: string[];
  outcome: NightlyOutcome;
  /** The failure's first line, or why the run was skipped. */
  reason?: string;
  short?: ShortOutcome;
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

interface NightlyPickContext {
  /** Match ids that already have a working directory — `listProcessedMatchIds()`. */
  processedIds: readonly number[];
  /** Ids the operator has hidden — `hiddenMatchIds()`. */
  hiddenIds: ReadonlySet<number>;
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
export function pickNightlyCandidate<T extends { metrics: { matchId: number } }>(
  suggestions: readonly T[],
  { processedIds, hiddenIds, freeMatches }: NightlyPickContext,
): T | null {
  if (freeMatches < MIN_FREE_MATCHES) return null;
  const processed = new Set(processedIds);
  return (
    suggestions.find((s) => !processed.has(s.metrics.matchId) && !hiddenIds.has(s.metrics.matchId)) ?? null
  );
}

export interface NightlyOptions {
  hourUtc: number;
  /** Empty string turns the notification off. */
  notifyUrl: string;
}

/**
 * The match this scheduler last started. Checked alongside every on-disk match, so a render that
 * has not yet created its working directory still counts as busy.
 */
let lastStartedId: number | null = null;

const renderInFlight = (): boolean =>
  (lastStartedId !== null && getJob(lastStartedId)?.done === false) ||
  listProcessedMatchIds().some((id) => getJob(id)?.done === false);

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
  outcome: Exclude<NightlyOutcome, "skipped">;
  /** The pipeline's error text can be a multi-KB stderr tail; a notification wants a line. */
  reason?: string;
}

function outcomeOf(job: Job): JobVerdict {
  if (job.aborted) return { outcome: "aborted" };
  if (!job.error) return { outcome: "done" };
  return { outcome: "failed", reason: job.error.split("\n")[0]?.slice(0, 200) ?? "unknown" };
}

/** The clause `chainShort` returns, as the tri-state the state file records. */
const shortOutcome = (clause: string): ShortOutcome =>
  clause === "" ? "skipped" : clause.startsWith(" + Short rendered") ? "done" : "failed";

/** Likewise for `chainExport`. */
const exportOutcome = (clause: string): ShortOutcome =>
  clause === "" ? "skipped" : clause === " + exported" ? "done" : "failed";

/**
 * The Short that follows the render, as the clause the notification gains for it.
 *
 * Chained here rather than left for the morning because the two halves of a match are one job:
 * the VODs are on disk, the moment scorer needs no video decoding, and the cut is minutes next
 * to the render itself. Only a clean `done` earns one — a failed pipeline may have left
 * nothing to cut from, and an abort is the operator saying stop, which a Short would ignore.
 *
 * `--pick=0` through shortsRoutes' own runner, so the dashboard button and the small hours run
 * the same command; nothing here duplicates the spawn.
 */
export async function chainShort(
  matchId: number,
  outcome: string,
  enabled: boolean,
  run: ShortRunner = spawnShortJob,
): Promise<string> {
  if (!enabled || outcome !== "done") return "";

  const proc = run(matchId, 0);
  // Drained as much as read: an unconsumed stdio pipe fills at 64 KB and stalls the render it
  // belongs to. The last line is kept because that is where the CLI puts its failure.
  let tail = "";
  const keep = (chunk: Buffer) => {
    const lines = chunk
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) tail = lines[lines.length - 1]!;
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);

  return new Promise<string>((resolve) => {
    proc.on("error", (err) => resolve(` + Short failed: ${describeError(err)}`));
    proc.on("close", (code) =>
      resolve(
        code === 0 ? " + Short rendered" : ` + Short failed: ${tail.slice(0, 120) || `exit code ${code}`}`,
      ),
    );
  });
}

/** Starts the encode and settles with its error line, or null. Injected by the tests. */
export type ExportStarter = (matchId: number) => Promise<string | null>;

const startFastExportOf: ExportStarter = (matchId) => startFastExport(matchId, matchDir(matchId)).finished;

/**
 * The finished MP4 after the Short, as its clause. Same gate as the Short: only a clean `done`,
 * and only when asked — a match the operator will cut in Kdenlive first has no business being
 * encoded uncut. Ten minutes on the lab's VAAPI, which is why it runs at 03:00 and not at the
 * first click of the morning.
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
 * Match ids whose render has a Short waiting on it — the nightly's own pick, and anything the
 * operator started with the dashboard's "Render + Short" — and, separately, those whose render
 * is to be encoded as well, which is the nightly's pick alone.
 *
 * Sets here rather than flags on the job, because jobs.ts is the plain render path shared with
 * the button and the TUI and has no business knowing what happens afterwards. `afterSettled` is
 * the only reader, and it consumes the entry, so two pollers on one job cannot cut two Shorts.
 */
const wantsShort = new Set<number>();
const wantsExport = new Set<number>();

export function requestShort(matchId: number): void {
  wantsShort.add(matchId);
}

export function requestExport(matchId: number): void {
  wantsExport.add(matchId);
}

/**
 * Waits out the render, cuts its Short and encodes the MP4 if asked for, and reports how it all
 * went.
 *
 * The one poller. The nightly and "Render + Short" both land here, so there is a single place
 * that decides a Short is earned and a single 30s timer per render. `report` is awaited after
 * both rather than before, because one notification for the lot is what anybody reads: three
 * pushes in the small hours for one match is two too many. The Short goes first: it is two
 * minutes to the export's ten, and if the encode dies the Short is at least on disk.
 */
export function afterSettled(
  job: Job,
  report?: (verdict: JobVerdict, shortClause: string, exportClause: string) => Promise<void> | void,
): void {
  const poll = () => void tick().catch((err: unknown) => console.error(`nightly: ${describeError(err)}`));
  const tick = async (): Promise<void> => {
    if (!job.done) {
      setTimeout(poll, SETTLE_POLL_MS);
      return;
    }
    const verdict = outcomeOf(job);
    const shortClause = await chainShort(job.matchId, verdict.outcome, wantsShort.delete(job.matchId));
    const exportClause = await chainExport(job.matchId, verdict.outcome, wantsExport.delete(job.matchId));
    await report?.(verdict, shortClause, exportClause);
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
  ranked: () => Promise<readonly Suggestion[] | null>;
}

const liveRanked = async (): Promise<readonly Suggestion[] | null> => {
  // Not `startScan(true)`: a forced rescan is hundreds of API requests. Unforced, the scan
  // returns the cache while it is fresh and walks only the matches played since the last one
  // when it is stale — so the pick is from tonight's feed, not from whenever the process booted.
  await startScan(false);
  const result = snapshot().result;
  return result ? orderForDisplay(result.suggestions) : null;
};

/** The disk-and-shelf half of the pick, shared by the run and the dashboard's preview of it. */
const pickContext = async (): Promise<NightlyPickContext> => ({
  processedIds: listProcessedMatchIds(),
  hiddenIds: hiddenMatchIds(),
  // A missing capacity reading (statfs failed, mediaDir gone) is not a licence to fill a disk.
  freeMatches: (await capacity()).working?.matchesLeft ?? 0,
});

/**
 * What a run right now would start, without starting it — the dashboard's preview.
 *
 * Deliberately never scans: a GET the browser polls must not be able to spend a scan's worth of
 * the MCSR request budget. No cached list simply means nothing to promise yet.
 */
export async function nightlyCandidate(): Promise<Suggestion | null> {
  const result = snapshot().result;
  return result ? pickNightlyCandidate(orderForDisplay(result.suggestions), await pickContext()) : null;
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
): Promise<NightlyRunResult> {
  const { renderInFlight: busy = renderInFlight, ranked = liveRanked } = deps;
  const startedAt = new Date().toISOString();
  const skip = (reason: string, conflict = false): NightlyRunResult => {
    console.error(`nightly: skipped — ${reason}`);
    // A conflict is the one skip that is not an outcome: the route answers it 409 and the run
    // already in flight is what the night produced. Recording it would replace last night's
    // real result with "skipped" on the strip.
    if (!conflict) writeNightlyState({ startedAt, matchId: null, players: [], outcome: "skipped", reason });
    return { skipped: reason, ...(conflict ? { busy: true } : {}) };
  };

  if (snapshot().scanning) return skip("a suggestion scan is running");
  if (busy()) return skip("a render is already in flight", true);

  const suggestions = await ranked();
  if (!suggestions) return skip("no suggestions available");

  const pick = pickNightlyCandidate(suggestions, await pickContext());
  if (!pick) return skip("every suggestion is processed or hidden, or the disk is full");
  // Checked again after the awaits above: a render clicked while the list was being ranked
  // must not get a second one started on top of it.
  if (busy()) return skip("a render is already in flight", true);

  const { matchId, players } = pick.metrics;
  const label = `${players[0]} vs ${players[1]}`;
  console.error(`nightly: starting render of #${matchId} ${label}`);
  lastStartedId = matchId;
  if (config.nightlyRenderShort) requestShort(matchId);
  if (config.nightlyRenderExport) requestExport(matchId);
  // The same call `POST /api/render` makes, so a nightly render and a clicked one are one code
  // path: startJob de-duplicates by match id and owns the whole pipeline invocation.
  const job = startJob(matchId);
  afterSettled(job, async (verdict, shortClause, exportClause) => {
    // State first, then the push, from the same values: a panel that disagreed with the
    // notification would be worse than either on its own.
    writeNightlyState({
      startedAt,
      matchId,
      players: [...players],
      outcome: verdict.outcome,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      short: shortOutcome(shortClause),
      export: exportOutcome(exportClause),
    });
    const said = verdict.reason ? `${verdict.outcome}: ${verdict.reason}` : verdict.outcome;
    if (notifyUrl) {
      await notify(notifyUrl, `Rendered #${matchId} ${label} — ${said}${shortClause}${exportClause}`);
    }
  });
  return { matchId, players: [...players] };
}

/**
 * Arms the nightly render and re-arms it after every run. Never throws: a scheduler that dies on
 * one bad night is worse than one that logs and tries again tomorrow.
 */
export function scheduleNightly(options: NightlyOptions): void {
  const delay = msUntilNextRun(Date.now(), options.hourUtc);
  console.error(`nightly: next auto-render at ${new Date(Date.now() + delay).toISOString()}`);
  setTimeout(() => {
    runNightlyOnce(options.notifyUrl)
      .catch((err: unknown) => console.error(`nightly: ${describeError(err)}`))
      .finally(() => scheduleNightly(options));
  }, delay);
}
