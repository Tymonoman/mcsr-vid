/**
 * `npm run studio -- worker` — a standalone loop (phase 2/3, 8 Oct 2026; CLAUDE.md's "Studio
 * automation" section) that does, on its own, what phase 1 only ever did on the dashboard's
 * nightly tick: add the operator's end-screen template to a long-form that has none, and run
 * Test & Compare experiments the dashboard's experiment engine has planned.
 *
 * Gated on `opts.enable` (the CLI's own `--enable`, or `STUDIO_WORKER=1`) OR'd with
 * `config.studioAutomation` — never on `config.studioAutomation` alone (phase 4, 8 Oct 2026). That
 * flag is also the dashboard's own switch for letting a real Chrome sign into the channel's
 * Google account from *its* container, which has no Chrome at all, so it must stay `false` there;
 * the operator's own words, his /goal, 7 Oct 2026: "the automation lives in the dashboard code,
 * not this session: when the usage limit hits, the channel keeps running" — but *this* loop runs
 * in the Claude container, started deliberately by a session with `nohup npm run studio --
 * worker --enable &`, which is the operator's own browser-automation grant exercised directly, not
 * a second, ungated path to the same browser the dashboard's flag was built to gate. Without
 * either, a cycle is still a no-op recorded as `"skipped"` — see CLAUDE.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { blockedIn, config, matchDir } from "../config.js";
import { povNicknamesOnDisk } from "../dashboard/matchStatus.js";
import { describeError } from "../errorText.js";
import {
  addEndScreenFromTemplate,
  readTestAndCompare,
  startTestAndCompare,
  type TcReadResult,
  type TcTest,
} from "./studioActions.js";
import { probe, start, type StudioBrowserOptions } from "./studioBrowser.js";
import {
  importTcPlan,
  readExperiments,
  updateTcExperiments,
  type Experiment,
  type TcPlanThumbEntry,
} from "./studioExperiments.js";
import { allUploads, splitTitle } from "./youtubeStore.js";

/** The operator's own end-screen template, set up by hand once (CLAUDE.md, the task's own FACTS). */
export const END_SCREEN_TEMPLATE_VIDEO_ID = "POQrpE0-5d8";
/** A long-form uploaded on or after this date is a candidate even while still private/scheduled. */
export const END_SCREEN_CUTOFF_ISO = "2026-10-07T00:00:00.000Z";
export const MAX_ENDSCREENS_PER_CYCLE = 3;
export const MAX_TC_STARTS_PER_CYCLE = 2;
/** A long-form uploaded by the chain on or after this date gets its own auto-planned thumbnail
 * Test & Compare (phase 4, 8 Oct 2026) — the day this feature shipped; nothing retroactive. */
export const THUMBNAIL_TC_CUTOFF_ISO = "2026-10-08T00:00:00.000Z";
export const MAX_THUMBNAIL_PLANS_PER_CYCLE = 2;
/** The caption arm only ships in this fully-automated flow when it is this short. A judge reads
 * every caption in the manual tc-plan.json flow (CLAUDE.md's "Phase 2/3"); nobody reviews this
 * one before it goes live on real viewers' thumbnails, so the ceiling here is tighter than
 * tcCaption.ts's own CAPTION_MAX_CHARS (9, the 8 Oct 2026 chip-truth fix) — "a caption is a clean
 * token or nothing" applies twice over when nobody is there to catch a borderline one. */
export const AUTO_CAPTION_MAX_CHARS = 6;
const CYCLE_MS = 20 * 60 * 1000;
const JITTER_MS = 3 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Ledger: what the worker has already done (`.studio-ledger.json`, atomic).
// ---------------------------------------------------------------------------

export interface StudioLedger {
  endScreens: Record<string, { at: string; matchId: number }>;
  /** The last UTC calendar date a video hit the picker's own confirmed account-scoping bug
   * (`"picker-empty"`) — not "done" (worth trying again once the bug is fixed), but bounds the
   * retry to once a day instead of every ~20 min cycle (added 8 Oct 2026: before this, a
   * standing `picker-empty` candidate re-opened the editor, and its two screenshots, on every
   * single cycle for as long as the bug lasts). */
  pickerEmptySeen: Record<string, string>;
}

const ledgerPath = (): string => path.join(config.mediaDir, ".studio-ledger.json");

export async function readLedger(): Promise<StudioLedger> {
  const file = ledgerPath();
  if (!existsSync(file)) return { endScreens: {}, pickerEmptySeen: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<StudioLedger>;
    return { endScreens: parsed.endScreens ?? {}, pickerEmptySeen: parsed.pickerEmptySeen ?? {} };
  } catch {
    // ponytail: a corrupt ledger just means "nothing recorded yet" — `addEndScreenFromTemplate`
    // checks the live editor for an existing end screen itself, so losing this file risks one
    // redundant (and safe) check per video, never a duplicate import.
    return { endScreens: {}, pickerEmptySeen: {} };
  }
}

export async function writeLedger(ledger: StudioLedger): Promise<void> {
  mkdirSync(config.mediaDir, { recursive: true });
  const target = ledgerPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, target);
}

export async function markEndScreenDone(videoId: string, matchId: number): Promise<void> {
  const ledger = await readLedger();
  ledger.endScreens[videoId] = { at: new Date().toISOString(), matchId };
  await writeLedger(ledger);
}

export async function markPickerEmptySeen(videoId: string, now: Date = new Date()): Promise<void> {
  const ledger = await readLedger();
  ledger.pickerEmptySeen[videoId] = now.toISOString();
  await writeLedger(ledger);
}

// ---------------------------------------------------------------------------
// Heartbeat: `.studio-worker.json`, so the morning report can say if the worker died.
// ---------------------------------------------------------------------------

export interface WorkerHeartbeat {
  pid: number;
  at: string;
  lastCycle: {
    at: string;
    probe: string;
    endScreensAdded: number;
    /** Hit the picker's own confirmed account-scoping bug this cycle (8 Oct 2026) — distinct
     * from `endScreensAdded: 0` with no error, which otherwise looks identical to "nothing to
     * do" on every cycle for as long as the bug lasts; a human watching the heartbeat for a week
     * needs to be able to tell those two apart. */
    endScreenPickerEmpty: number;
    tcStarted: number;
    tcChecked: number;
    thumbnailTestsPlanned: number;
  } | null;
  /** The first error of the cycle, kept for anything that only ever read this one field. */
  lastError: string | null;
  /** Every error the cycle collected, not just the first — `tcStarted`/`tcChecked` can each
   * contribute one independently of an end-screen error, and truncating to `errors[0]` silently
   * dropped the rest (fixed 8 Oct 2026). */
  lastErrors: string[];
}

const heartbeatPath = (): string => path.join(config.mediaDir, ".studio-worker.json");

export async function writeHeartbeat(hb: WorkerHeartbeat): Promise<void> {
  mkdirSync(config.mediaDir, { recursive: true });
  const target = heartbeatPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(hb, null, 2));
  await rename(tmp, target);
}

export async function readHeartbeat(): Promise<WorkerHeartbeat | null> {
  const file = heartbeatPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as WorkerHeartbeat;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure planning — no browser, no fs — so "what does this cycle do" is a plain unit test.
// ---------------------------------------------------------------------------

export interface LongFormRef {
  videoId: string;
  matchId: number;
  uploadedAt: string;
  privacyStatus: string;
  /** Absent on a record written before source tracking existed (`UploadRecord.source`,
   *  youtubeStore.ts) — the auto-thumbnail-test filter below only ever matches `"dashboard"`. */
  source?: "dashboard" | "studio";
}

export interface CyclePlan {
  endScreenTargets: LongFormRef[];
  tcToStart: Experiment[];
  tcToCheck: Experiment[];
  /** New dashboard-chain long-forms with no tc experiment of their own yet (phase 4, 8 Oct
   *  2026) — `runCycle` renders each one's thumbnail set and plans a "tc" experiment for it,
   *  which a *later* cycle's own `tcToStart` picks up, never this same cycle's. */
  thumbnailTcTargets: LongFormRef[];
}

const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** "Once a day" per running experiment, by UTC calendar date rather than exact elapsed hours —
 * robust against the worker's own ±3 min cycle jitter ever skipping a day by a cycle's width. */
function needsDailyCheck(e: Experiment, now: Date): boolean {
  const checkedAt = (e.result as { checkedAt?: string } | undefined)?.checkedAt;
  return !checkedAt || utcDate(new Date(checkedAt)) !== utcDate(now);
}

/** Same "once a day" shape as `needsDailyCheck`, for a video that already hit the picker's own
 * confirmed bug this UTC day — worth trying again a future cycle (the bug may get fixed), not
 * every ~20 min cycle in the meantime. */
function pickerEmptyToday(videoId: string, ledger: StudioLedger, now: Date): boolean {
  const seenAt = ledger.pickerEmptySeen[videoId];
  return !!seenAt && utcDate(new Date(seenAt)) === utcDate(now);
}

/** The real "is this match's own POV footage a blocked runner's" check (CLAUDE.md's "Blocked
 * players") — `planCycle`'s own default, overridable by a test with a plain stub so the rest of
 * its logic stays a pure, filesystem-free unit test. */
const realIsBlocked = (matchId: number): boolean => blockedIn(povNicknamesOnDisk(matchDir(matchId)));

export function planCycle(
  now: Date,
  longForms: readonly LongFormRef[],
  ledger: StudioLedger,
  experiments: readonly Experiment[],
  isBlocked: (matchId: number) => boolean = realIsBlocked,
): CyclePlan {
  const endScreenTargets = longForms
    .filter((v) => !ledger.endScreens[v.videoId])
    .filter((v) => v.uploadedAt >= END_SCREEN_CUTOFF_ISO || v.privacyStatus === "public")
    .filter((v) => !pickerEmptyToday(v.videoId, ledger, now))
    .slice(0, MAX_ENDSCREENS_PER_CYCLE);

  const tc = experiments.filter((e) => e.kind === "tc");
  const tcToStart = tc.filter((e) => e.status === "planned").slice(0, MAX_TC_STARTS_PER_CYCLE);
  const tcToCheck = tc.filter((e) => e.status === "running" && needsDailyCheck(e, now));

  // "no tc experiment yet" (the task's own words) means any kind — Studio only ever runs one
  // Test & Compare per video at a time anyway, so a video already in a title test is not also
  // offered a thumbnail one.
  const alreadyTested = new Set(
    tc.flatMap((e) => e.videos.map((v) => v.videoId).filter((id): id is string => !!id)),
  );
  const thumbnailTcTargets = longForms
    .filter((v) => v.source === "dashboard")
    .filter((v) => v.uploadedAt >= THUMBNAIL_TC_CUTOFF_ISO)
    .filter((v) => !alreadyTested.has(v.videoId))
    .filter((v) => !isBlocked(v.matchId))
    .slice(0, MAX_THUMBNAIL_PLANS_PER_CYCLE);

  return { endScreenTargets, tcToStart, tcToCheck, thumbnailTcTargets };
}

const MINUTES_PER_DAY = 24 * 60;
/** 10 minutes of lead-in before `nightlyRenderHourUtc` (`sweepArchive` and friends run ahead of
 * the render itself) plus the 4-hour chain window `nightlyMaxRenders` above 1 can use
 * (`CHAIN_WINDOW_MS`, `src/dashboard/nightly.ts`) plus 30 minutes for that last chained render to
 * actually finish (lab timings: ~12-21 min). */
const BLACKOUT_WINDOW_MIN = 10 + 4 * 60 + 30;

/**
 * The nightly render's own window (CLAUDE.md "The NAS", `inNasWindow`'s sibling): Chrome and
 * ffmpeg share the lab's four cores, so the worker simply does not run here. Read live from
 * `config.nightlyRenderHourUtc` (default 3, a Settings-tab field `scheduleNightly` re-reads on
 * every arm with no restart) rather than a hardcoded 02:50-04:30 — fixed 8 Oct 2026, since a
 * hardcoded window silently desynced from an operator's hour change, and was narrower than a
 * chained nightly render (`nightlyMaxRenders` above 1) can actually run late into. `null`
 * (nightly disabled) turns the blackout off too — nothing to avoid colliding with.
 */
export function inBlackoutWindow(now: Date, hourUtc: number | null = config.nightlyRenderHourUtc): boolean {
  if (hourUtc === null) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = (((hourUtc * 60 - 10) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const sinceStart = (((minutes - start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return sinceStart <= BLACKOUT_WINDOW_MIN;
}

/** The two single-variable `TcTest`s `startTestAndCompare` accepts, built from an experiment's
 * own arms — null when the experiment carries neither a usable title nor thumbnail set, which
 * `runCycle` reports as an error rather than silently skip. */
export function testFor(exp: Experiment): TcTest | null {
  const control = exp.controlArm ?? "control";
  if (exp.variable === "title") {
    const titles = exp.arms
      .filter((a) => a.name !== control)
      .map((a) => (a.settings as { title?: string } | undefined)?.title)
      .filter((t): t is string => !!t);
    return titles.length ? { kind: "title", titles } : null;
  }
  if (exp.variable === "thumbnail") {
    const files = exp.arms
      .map((a) => (a.settings as { file?: string } | undefined)?.file)
      .filter((f): f is string => !!f);
    return files.length >= 2 ? { kind: "thumbnail", files } : null;
  }
  return null;
}

/** The two nicknames a title experiment's control arm names, read the same way every title check
 * in this codebase does (`splitTitle`) — empty for a thumbnail experiment, which needs none. */
export function playersFor(exp: Experiment): { nickname: string }[] {
  const control = exp.arms.find((a) => a.name === (exp.controlArm ?? "control"));
  const liveTitle = (control?.settings as { title?: string } | undefined)?.title;
  const parts = liveTitle ? splitTitle(liveTitle) : null;
  return parts ? [{ nickname: parts.left }, { nickname: parts.right }] : [];
}

// ---------------------------------------------------------------------------
// IO: one cycle, one browser session.
// ---------------------------------------------------------------------------

async function setNeedsHuman(id: string, reason: string): Promise<void> {
  await updateTcExperiments((tc) => tc.map((e) => (e.id === id ? { ...e, needsHuman: reason } : e)));
}

async function setExperimentRunning(id: string): Promise<void> {
  await updateTcExperiments((tc) =>
    tc.map((e) => (e.id === id ? { ...e, status: "running", start: new Date().toISOString() } : e)),
  );
}

/**
 * Records what `readTestAndCompare` saw, for both of its callers: the daily check of an
 * already-`"running"` experiment (the only caller before 8 Oct 2026), and — since phase 4 —
 * reconciling a `"planned"` one the `tcToStart` loop below finds *already* running live (started
 * outside this bookkeeping entirely, e.g. a manual `npm run studio -- tc` CLI press before the
 * experiment ever existed — exactly LUI5E7yF0zE's own history). Either way, `"running"`/`"done"`
 * read off the real page always wins over whatever status this experiment already had — a
 * `"planned"` experiment is promoted to `"running"` (with a `start` it may not have had yet)
 * rather than left `"planned"` with no indication Studio has already started it, which would
 * otherwise never again be picked up by `tcToCheck`'s own `status === "running"` filter.
 */
export async function setExperimentChecked(id: string, read: TcReadResult): Promise<void> {
  const checkedAt = new Date().toISOString();
  await updateTcExperiments((tc) =>
    tc.map((e) => {
      if (e.id !== id) return e;
      if (read.state !== "done")
        return { ...e, status: "running", start: e.start ?? checkedAt, result: { checkedAt, raw: read.raw } };
      return {
        ...e,
        status: "done",
        end: checkedAt,
        // YouTube's own winner is the live title/thumbnail it already applied — this never sets
        // one by hand, only records what `readTestAndCompare` read off the real page.
        result: { checkedAt, winner: read.winner, raw: read.raw },
        verdict: read.winner ? `YouTube applied: ${read.winner}` : "done (no winner text read)",
      };
    }),
  );
}

interface TcThumbResult {
  matchId: number;
  files: string[];
  caption: string | null;
}

/**
 * Spawns the existing `npm run tc-thumbs` (src/thumbnails/tcThumbs.ts) for one match — reused
 * rather than reimplemented, the same way `startFastExport` (src/dashboard/exportRoutes.ts)
 * shells out to `npm run export:fast` for its own heavy render instead of calling into it as a
 * library. Its own logic already gives exactly what the task asks for: control + the
 * most-different non-result-looking pose + a caption only when one passes its checks — this
 * worker adds nothing on top except, in `runCycle`, dropping the caption arm when it is longer
 * than `AUTO_CAPTION_MAX_CHARS`.
 */
function renderTcThumbSet(matchId: number): Promise<TcThumbResult | { error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["run", "--silent", "tc-thumbs", "--", String(matchId)], {
      cwd: path.resolve(new URL("../..", import.meta.url).pathname),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", (e) => resolve({ error: describeError(e) }));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ error: `tc-thumbs exit ${code}: ${err.slice(-500) || "(no stderr)"}` });
        return;
      }
      try {
        const results = JSON.parse(out) as TcThumbResult[];
        const result = results.find((r) => r.matchId === matchId);
        resolve(result ?? { error: "tc-thumbs produced no result for this match" });
      } catch (parseErr) {
        resolve({ error: `tc-thumbs output did not parse as JSON: ${describeError(parseErr)}` });
      }
    });
  });
}

export interface CycleResult {
  probe: string;
  endScreensAdded: number;
  /** See `WorkerHeartbeat.lastCycle.endScreenPickerEmpty`. */
  endScreenPickerEmpty: number;
  tcStarted: number;
  tcChecked: number;
  /** New dashboard long-forms whose thumbnail set got rendered and a "tc" experiment planned for
   *  this cycle (phase 4, 8 Oct 2026) — distinct from `tcStarted`, since the plan always waits for
   *  a *later* cycle's own `tcToStart` (see `CyclePlan.thumbnailTcTargets`'s own comment). */
  thumbnailTestsPlanned: number;
  errors: string[];
}

const SKIPPED_RESULT: CycleResult = {
  probe: "skipped",
  endScreensAdded: 0,
  endScreenPickerEmpty: 0,
  tcStarted: 0,
  tcChecked: 0,
  thumbnailTestsPlanned: 0,
  errors: [],
};

/**
 * One cycle: probe, then at most `MAX_ENDSCREENS_PER_CYCLE` end screens and
 * `MAX_TC_STARTS_PER_CYCLE` new Test & Compare starts, then a daily check of every running one —
 * all in the one browser session `start()`/`handle.stop()` bracket. A non-`ok` probe ends the
 * cycle immediately, per the plan's own "no retry loop" rule; `probe()` itself already writes
 * `.studio-probe.json` for the nightly strip to read.
 */
export async function runCycle(
  opts: { dryRun?: boolean; startOpts?: StudioBrowserOptions; enable?: boolean } = {},
): Promise<CycleResult> {
  if (!opts.enable && !config.studioAutomation) return SKIPPED_RESULT;

  const errors: string[] = [];
  const handle = await start(opts.startOpts);
  try {
    const probed = await probe(handle);
    if (probed.result !== "ok") {
      return {
        ...SKIPPED_RESULT,
        probe: probed.result,
        errors: [`Studio ${probed.result}: ${probed.title}`],
      };
    }

    const longForms: LongFormRef[] = (await allUploads()).map(({ matchId, record }) => ({
      videoId: record.videoId,
      matchId,
      uploadedAt: record.uploadedAt,
      privacyStatus: record.privacyStatus,
      source: record.source,
    }));
    const ledger = await readLedger();
    const experimentsFile = await readExperiments();
    const plan = planCycle(new Date(), longForms, ledger, experimentsFile.experiments);

    let endScreensAdded = 0;
    let endScreenPickerEmpty = 0;
    for (const target of plan.endScreenTargets) {
      const outcome = await addEndScreenFromTemplate(handle, target.videoId, END_SCREEN_TEMPLATE_VIDEO_ID, {
        matchId: target.matchId,
        dryRun: opts.dryRun,
      });
      if (typeof outcome === "object") {
        errors.push(`end screen ${target.videoId}: ${outcome.error}`);
        continue;
      }
      if (outcome === "already-has-endscreen") {
        await markEndScreenDone(target.videoId, target.matchId);
      } else if (outcome === "imported" && !opts.dryRun) {
        await markEndScreenDone(target.videoId, target.matchId);
        endScreensAdded++;
      } else if (outcome === "picker-empty") {
        // The picker's own confirmed account-scoping bug (7 Oct 2026) is left unmarked as
        // "done" on purpose — not done, and worth trying again a future cycle rather than
        // permanently. `markPickerEmptySeen` only bounds the retry to once a UTC day
        // (`planCycle`'s own filter) instead of every ~20 min cycle, and `endScreenPickerEmpty`
        // below makes the standing bug visible on the heartbeat rather than indistinguishable
        // from "nothing to do" (fixed 8 Oct 2026 — see WorkerHeartbeat.lastCycle's own comment).
        if (!opts.dryRun) await markPickerEmptySeen(target.videoId);
        endScreenPickerEmpty++;
      }
    }

    let tcStarted = 0;
    let tcChecked = 0;
    for (const exp of plan.tcToStart) {
      const video = exp.videos[0];
      if (!video?.videoId) {
        errors.push(`${exp.id}: no videoId on the experiment yet`);
        continue;
      }
      // A test can already be running on the real page — started outside this bookkeeping
      // entirely (a manual `npm run studio -- tc` CLI press before this experiment ever existed,
      // exactly LUI5E7yF0zE's own history, phase 4 8 Oct 2026). Reconcile ground truth rather
      // than ever call startTestAndCompare a second time on it, which Studio refuses anyway (see
      // its own "a test may already be set up" error below).
      const existing = await readTestAndCompare(handle, video.videoId);
      if (!("error" in existing) && existing.state !== "none") {
        await setExperimentChecked(exp.id, existing);
        tcChecked++;
        continue;
      }
      const test = testFor(exp);
      if (!test) {
        errors.push(`${exp.id}: no usable arms`);
        await setNeedsHuman(exp.id, "no usable arms for startTestAndCompare");
        continue;
      }
      const outcome = await startTestAndCompare(handle, video.videoId, test, {
        matchId: video.matchId,
        dryRun: opts.dryRun,
        players: playersFor(exp),
      });
      if (typeof outcome === "object") {
        errors.push(`${exp.id}: ${outcome.error}`);
        await setNeedsHuman(exp.id, outcome.error);
        continue;
      }
      if (!opts.dryRun) {
        await setExperimentRunning(exp.id);
        tcStarted++;
      }
    }

    for (const exp of plan.tcToCheck) {
      const video = exp.videos[0];
      if (!video?.videoId) continue;
      const read = await readTestAndCompare(handle, video.videoId);
      if ("error" in read) {
        errors.push(`${exp.id}: ${read.error}`);
        await setNeedsHuman(exp.id, read.error);
        continue;
      }
      await setExperimentChecked(exp.id, read);
      tcChecked++;
    }

    // New dashboard long-forms get a thumbnail Test & Compare planned for them automatically
    // (phase 4, 8 Oct 2026) — rendering is heavy (ffmpeg SSIM + a Remotion still) but touches no
    // Studio page at all, so it needs no browser session of its own; it rides along in this one
    // only because `runCycle` already has one open. Skipped under `--dry-run`: unlike everything
    // above, there is no "stop right before the last click" point to fall back on here — the
    // render and the `.experiments.json` write are the whole action, so a dry run simply does
    // neither, exactly as `--dry-run` promises elsewhere in this file.
    let thumbnailTestsPlanned = 0;
    if (!opts.dryRun) {
      for (const target of plan.thumbnailTcTargets) {
        const rendered = await renderTcThumbSet(target.matchId);
        if ("error" in rendered) {
          errors.push(`thumbnail tc ${target.videoId}: ${rendered.error}`);
          continue;
        }
        const includeCaption = rendered.caption !== null && rendered.caption.length <= AUTO_CAPTION_MAX_CHARS;
        const files = includeCaption ? rendered.files : rendered.files.slice(0, 2);
        const entry: TcPlanThumbEntry = {
          matchId: target.matchId,
          videoId: target.videoId,
          variants: files,
          approved: true,
        };
        const { added, skipped } = await importTcPlan({ thumbnails: [entry] });
        if (added.length) thumbnailTestsPlanned++;
        for (const s of skipped) errors.push(`thumbnail tc ${s.videoId}: ${s.reason}`);
      }
    }

    return {
      probe: probed.result,
      endScreensAdded,
      endScreenPickerEmpty,
      tcStarted,
      tcChecked,
      thumbnailTestsPlanned,
      errors,
    };
  } finally {
    await handle.stop();
  }
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

function jitteredDelayMs(): number {
  return CYCLE_MS + Math.round((Math.random() * 2 - 1) * JITTER_MS);
}

/**
 * Runs cycles forever (or once, with `--once`), human-paced between videos within a cycle
 * (`randomPause` in `studioActions.ts`) and ~20 min ± 3 min between cycles. Never runs inside
 * `inBlackoutWindow` — that cycle is recorded as `"skipped"` and the loop waits for the next one
 * rather than busy-poll the clock. `opts.enable` is this module's own top-of-file comment's gate.
 */
export async function runWorker(
  opts: { once?: boolean; dryRun?: boolean; startOpts?: StudioBrowserOptions; enable?: boolean } = {},
): Promise<void> {
  for (;;) {
    const now = new Date();
    let result: CycleResult;
    if (inBlackoutWindow(now)) {
      result = SKIPPED_RESULT;
    } else {
      try {
        result = await runCycle({ dryRun: opts.dryRun, startOpts: opts.startOpts, enable: opts.enable });
      } catch (err) {
        result = { ...SKIPPED_RESULT, probe: "error", errors: [describeError(err)] };
      }
    }
    await writeHeartbeat({
      pid: process.pid,
      at: new Date().toISOString(),
      lastCycle: {
        at: now.toISOString(),
        probe: result.probe,
        endScreensAdded: result.endScreensAdded,
        endScreenPickerEmpty: result.endScreenPickerEmpty,
        tcStarted: result.tcStarted,
        tcChecked: result.tcChecked,
        thumbnailTestsPlanned: result.thumbnailTestsPlanned,
      },
      lastError: result.errors[0] ?? null,
      lastErrors: result.errors,
    });
    if (opts.once) return;
    await sleep(jitteredDelayMs());
  }
}
