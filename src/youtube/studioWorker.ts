/**
 * `npm run studio -- worker` — a standalone loop (phase 2/3, 8 Oct 2026; CLAUDE.md's "Studio
 * automation" section) that does, on its own, what phase 1 only ever did on the dashboard's
 * nightly tick: add the operator's end-screen template to a long-form that has none, and run
 * Test & Compare experiments the dashboard's (not-yet-merged) experiment engine has planned.
 *
 * Gated on `config.studioAutomation` exactly like `retryPendingStudio` (src/youtube/youtubeUpload.ts)
 * — the box's own deliberate switch for "a real Chrome is ever allowed to sign into the channel's
 * Google account", on or off, covers this loop too rather than it being a second, ungated way to
 * reach the same browser. See CLAUDE.md for why this gate is load-bearing rather than incidental.
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import {
  addEndScreenFromTemplate,
  readTestAndCompare,
  startTestAndCompare,
  type TcReadResult,
  type TcTest,
} from "./studioActions.js";
import { probe, start, type StudioBrowserOptions } from "./studioBrowser.js";
import { readExperiments, updateTcExperiments, type Experiment } from "./studioExperiments.js";
import { allUploads, splitTitle } from "./youtubeStore.js";

/** The operator's own end-screen template, set up by hand once (CLAUDE.md, the task's own FACTS). */
export const END_SCREEN_TEMPLATE_VIDEO_ID = "POQrpE0-5d8";
/** A long-form uploaded on or after this date is a candidate even while still private/scheduled. */
export const END_SCREEN_CUTOFF_ISO = "2026-10-07T00:00:00.000Z";
export const MAX_ENDSCREENS_PER_CYCLE = 3;
export const MAX_TC_STARTS_PER_CYCLE = 2;
const CYCLE_MS = 20 * 60 * 1000;
const JITTER_MS = 3 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Ledger: what the worker has already done (`.studio-ledger.json`, atomic).
// ---------------------------------------------------------------------------

export interface StudioLedger {
  endScreens: Record<string, { at: string; matchId: number }>;
}

const ledgerPath = (): string => path.join(config.mediaDir, ".studio-ledger.json");

export async function readLedger(): Promise<StudioLedger> {
  const file = ledgerPath();
  if (!existsSync(file)) return { endScreens: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<StudioLedger>;
    return { endScreens: parsed.endScreens ?? {} };
  } catch {
    // ponytail: a corrupt ledger just means "nothing recorded yet" — `addEndScreenFromTemplate`
    // checks the live editor for an existing end screen itself, so losing this file risks one
    // redundant (and safe) check per video, never a duplicate import.
    return { endScreens: {} };
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
    tcStarted: number;
    tcChecked: number;
  } | null;
  lastError: string | null;
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
}

export interface CyclePlan {
  endScreenTargets: LongFormRef[];
  tcToStart: Experiment[];
  tcToCheck: Experiment[];
}

const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** "Once a day" per running experiment, by UTC calendar date rather than exact elapsed hours —
 * robust against the worker's own ±3 min cycle jitter ever skipping a day by a cycle's width. */
function needsDailyCheck(e: Experiment, now: Date): boolean {
  const checkedAt = (e.result as { checkedAt?: string } | undefined)?.checkedAt;
  return !checkedAt || utcDate(new Date(checkedAt)) !== utcDate(now);
}

export function planCycle(
  now: Date,
  longForms: readonly LongFormRef[],
  ledger: StudioLedger,
  experiments: readonly Experiment[],
): CyclePlan {
  const endScreenTargets = longForms
    .filter((v) => !ledger.endScreens[v.videoId])
    .filter((v) => v.uploadedAt >= END_SCREEN_CUTOFF_ISO || v.privacyStatus === "public")
    .slice(0, MAX_ENDSCREENS_PER_CYCLE);

  const tc = experiments.filter((e) => e.kind === "tc");
  const tcToStart = tc.filter((e) => e.status === "planned").slice(0, MAX_TC_STARTS_PER_CYCLE);
  const tcToCheck = tc.filter((e) => e.status === "running" && needsDailyCheck(e, now));

  return { endScreenTargets, tcToStart, tcToCheck };
}

/** The nightly render's own window (CLAUDE.md "The NAS", `inNasWindow`'s sibling): Chrome and
 * ffmpeg share the lab's four cores, so the worker simply does not run here — same hours the
 * task names, checked in UTC since that is what every other blackout in this codebase uses. */
export function inBlackoutWindow(now: Date): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= 2 * 60 + 50 && minutes <= 4 * 60 + 30;
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

async function setExperimentChecked(id: string, read: TcReadResult): Promise<void> {
  const checkedAt = new Date().toISOString();
  await updateTcExperiments((tc) =>
    tc.map((e) => {
      if (e.id !== id) return e;
      if (read.state !== "done") return { ...e, result: { checkedAt, raw: read.raw } };
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

export interface CycleResult {
  probe: string;
  endScreensAdded: number;
  tcStarted: number;
  tcChecked: number;
  errors: string[];
}

const SKIPPED_RESULT: CycleResult = {
  probe: "skipped",
  endScreensAdded: 0,
  tcStarted: 0,
  tcChecked: 0,
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
  opts: { dryRun?: boolean; startOpts?: StudioBrowserOptions } = {},
): Promise<CycleResult> {
  if (!config.studioAutomation) return SKIPPED_RESULT;

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
    }));
    const ledger = await readLedger();
    const experimentsFile = await readExperiments();
    const plan = planCycle(new Date(), longForms, ledger, experimentsFile.experiments);

    let endScreensAdded = 0;
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
      }
      // "picker-empty" (the picker's own confirmed bug, 7 Oct 2026) is left unmarked on purpose:
      // not done, and worth trying again a future cycle rather than permanently — the per-cycle
      // cap of 3 already bounds how often that retry costs anything.
    }

    let tcStarted = 0;
    for (const exp of plan.tcToStart) {
      const video = exp.videos[0];
      if (!video?.videoId) {
        errors.push(`${exp.id}: no videoId on the experiment yet`);
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

    let tcChecked = 0;
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

    return { probe: probed.result, endScreensAdded, tcStarted, tcChecked, errors };
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
 * rather than busy-poll the clock.
 */
export async function runWorker(
  opts: { once?: boolean; dryRun?: boolean; startOpts?: StudioBrowserOptions } = {},
): Promise<void> {
  for (;;) {
    const now = new Date();
    let result: CycleResult;
    if (inBlackoutWindow(now)) {
      result = SKIPPED_RESULT;
    } else {
      try {
        result = await runCycle({ dryRun: opts.dryRun, startOpts: opts.startOpts });
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
        tcStarted: result.tcStarted,
        tcChecked: result.tcChecked,
      },
      lastError: result.errors[0] ?? null,
    });
    if (opts.once) return;
    await sleep(jitteredDelayMs());
  }
}
