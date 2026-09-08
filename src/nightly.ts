/**
 * One render a night, started by the clock instead of by a click.
 *
 * The channel's bottleneck is not compute, it is operator minutes: every render is a "Render
 * this" click followed by a 30-45 minute wait that nobody watches. The dashboard already scores
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
 *   - it stops well before the SSD does (a finished match is ~7 GB), because a render that dies
 *     at the write stage has burned the whole night for nothing.
 *
 * What it does do unprompted is cut the Short of the match it just rendered (`nightlyRenderShort`),
 * because that is the same footage, already on disk, and a morning with a video and no Short is a
 * morning with half the publishing done.
 */
import { capacity } from "./archive.js";
import { config } from "./config.js";
import { describeError } from "./errorText.js";
import { getJob, startJob, type Job } from "./jobs.js";
import { hiddenMatchIds } from "./matchShelf.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { spawnShortCli, type ShortRunner } from "./shortsRoutes.js";
import { snapshot, startScan } from "./suggestScan.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Room for this render and one more. At ~7 GB a match, the last slot is not worth taking. */
const MIN_FREE_MATCHES = 2;

/** jobs.ts offers no completion callback, and a render is 30-45 minutes, so poll coarsely. */
const SETTLE_POLL_MS = 30_000;

/** ntfy.sh and friends answer fast or not at all; a hung POST must not outlive the render. */
const NOTIFY_TIMEOUT_MS = 10_000;

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

export interface NightlyPickContext {
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

function outcomeOf(job: Job): string {
  if (job.aborted) return "aborted";
  if (!job.error) return "done";
  // The pipeline's error text can be a multi-KB stderr tail; a push notification wants a line.
  return `failed: ${job.error.split("\n")[0]?.slice(0, 200) ?? "unknown"}`;
}

/**
 * The Short that follows the render, as the clause the notification gains for it.
 *
 * Chained here rather than left for the morning because the two halves of a match are one job:
 * the VODs are on disk, the moment scorer needs no video decoding, and the cut is minutes next
 * to the render's 30-45. Only a clean `done` earns one — a failed pipeline may have left
 * nothing to cut from, and an abort is the operator saying stop, which a Short would ignore.
 *
 * `--pick=0` through shortsRoutes' own runner, so the dashboard button and the small hours run
 * the same command; nothing here duplicates the spawn.
 */
export async function chainShort(
  matchId: number,
  outcome: string,
  enabled: boolean,
  run: ShortRunner = spawnShortCli,
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

/**
 * Waits out the render, cuts its Short, and posts the one line that says how both went.
 *
 * One notification for the pair, which is why the Short is awaited before the POST: two pushes
 * in the small hours for one match is one more than anybody reads.
 */
function afterSettled(job: Job, url: string, label: string): void {
  const poll = () => void tick().catch((err: unknown) => console.error(`nightly: ${describeError(err)}`));
  const tick = async (): Promise<void> => {
    if (!job.done) {
      setTimeout(poll, SETTLE_POLL_MS);
      return;
    }
    const outcome = outcomeOf(job);
    const short = await chainShort(job.matchId, outcome, config.nightlyRenderShort);
    if (url) await notify(url, `Rendered #${job.matchId} ${label} — ${outcome}${short}`);
  };
  poll();
}

async function runNightly({ notifyUrl }: NightlyOptions): Promise<void> {
  if (snapshot().scanning) {
    console.error("nightly: skipped — a suggestion scan is running");
    return;
  }
  if (renderInFlight()) {
    console.error("nightly: skipped — a render is already in flight");
    return;
  }

  // Not `startScan(true)`: a forced rescan is hundreds of API requests, and the cached list is
  // exactly what the operator would be choosing from. Only a cold process needs a scan at all.
  if (!snapshot().result) await startScan(false);
  const result = snapshot().result;
  if (!result) {
    console.error("nightly: skipped — no suggestions available");
    return;
  }

  const pick = pickNightlyCandidate(result.suggestions, {
    processedIds: listProcessedMatchIds(),
    hiddenIds: hiddenMatchIds(),
    // A missing capacity reading (statfs failed, mediaDir gone) is not a licence to fill a disk.
    freeMatches: (await capacity()).working?.matchesLeft ?? 0,
  });
  if (!pick) {
    console.error(
      "nightly: nothing to render — every suggestion is processed or hidden, or the disk is full",
    );
    return;
  }

  const { matchId, players } = pick.metrics;
  const label = `${players[0]} vs ${players[1]}`;
  console.error(`nightly: starting render of #${matchId} ${label}`);
  lastStartedId = matchId;
  // The same call `POST /api/render` makes, so a nightly render and a clicked one are one code
  // path: startJob de-duplicates by match id and owns the whole pipeline invocation.
  const job = startJob(matchId);
  afterSettled(job, notifyUrl, label);
}

/**
 * Arms the nightly render and re-arms it after every run. Never throws: a scheduler that dies on
 * one bad night is worse than one that logs and tries again tomorrow.
 */
export function scheduleNightly(options: NightlyOptions): void {
  const delay = msUntilNextRun(Date.now(), options.hourUtc);
  console.error(`nightly: next auto-render at ${new Date(Date.now() + delay).toISOString()}`);
  setTimeout(() => {
    runNightly(options)
      .catch((err: unknown) => console.error(`nightly: ${describeError(err)}`))
      .finally(() => scheduleNightly(options));
  }, delay);
}
