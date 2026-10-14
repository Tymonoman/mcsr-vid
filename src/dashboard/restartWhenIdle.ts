/**
 * `POST /api/restart-when-idle`: arm a pending restart for the moment the box is next idle.
 *
 * This Claude container has no docker CLI or socket, so new dashboard code only reaches the
 * running process when it restarts — and `compose.yaml` runs it under tini with `restart:
 * unless-stopped`, so a clean `process.exit(0)` is all a restart takes: Docker brings the process
 * back up on the same bind-mounted, now-updated code. The standing rule is never to restart while
 * a chain uploads (a 1 Oct 2026 restart cut a Grand Final upload at 30%), so arming only starts a
 * timer that waits for every such thing to finish before it ever touches `process.exit`.
 *
 * Armed, every 30 s `idle()` reads the same job registries the rest of the dashboard already
 * reads for the same reason (the delete guard in server.ts, the nightly's own busy check): no
 * render, export, Short render, pick, upload chain or upload is in flight, no upload session file
 * is sitting on disk waiting to be resumed, no NAS copy is running, and the clock is not inside
 * the 20 minutes before the nightly might fire. Idle, it runs `tsc --noEmit` as a boot check
 * before it dares exit — new code that would not even type-check must never be the reason the
 * channel stops updating until someone notices by hand.
 *
 * 8 Oct 2026, the operator's goal for the week ("get the YPP ETA back to last week's pace …
 * the automation lives in the dashboard code, not this session"): this is what lets a session
 * that is out of its own usage limit still ship into the running box.
 */
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { allArchiveStates } from "./archive.js";
import { anyExportRunning } from "./exportRoutes.js";
import { anyJobRunning } from "./jobs.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { msUntilNextRun, nightlyChainRunning } from "./nightly.js";
import { repoHead } from "./repoHead.js";
import { anyShortRunning } from "./shortsRoutes.js";
import { chainsRunning, picksRunning } from "./shortFlow.js";
import { anyThumbnailRunning } from "../thumbnails/rerender.js";
import { SESSION_LIFE_MS } from "../youtube/youtube.js";
import { anyUploadRunning } from "../youtube/youtubeUpload.js";
import { anyVideoWriting } from "../youtube/youtubeStore.js";

/** How often `idle()` is re-checked while a restart is armed. */
const CHECK_INTERVAL_MS = 30_000;

/** An arm nobody ever sees go idle is abandoned rather than left pending forever. */
const EXPIRE_MS = 6 * 60 * 60 * 1000;

/** `npx tsc --noEmit` on a repo this size finishes well under this; it is the ceiling, not the norm. */
const TSC_TIMEOUT_MS = 5 * 60_000;

/** Nothing starts in the 20 minutes before the nightly might fire, so a restart never races it. */
const NIGHTLY_GUARD_MS = 20 * 60_000;

/** `.upload-session-<name>.json` (src/youtube/youtube.ts `sessionPath`) beside an export in progress. */
const UPLOAD_SESSION_RE = /^\.upload-session-.*\.json$/;

/**
 * A resumable upload session sitting on disk for any match — `shortTick` would pick it up next.
 * One past `SESSION_LIFE_MS` is dead (a chunk failure keeps the file, and a match settled in
 * Studio meanwhile never removes it) and must not hold a restart for ever.
 */
export function anyUploadSessionFile(nowMs: number = Date.now()): boolean {
  return listProcessedMatchIds().some((id) => {
    try {
      const dir = matchDir(id);
      return readdirSync(dir).some(
        (name) => UPLOAD_SESSION_RE.test(name) && nowMs - statSync(path.join(dir, name)).mtimeMs < SESSION_LIFE_MS,
      );
    } catch {
      // Deleted between the listing and the read — not a session file either way.
      return false;
    }
  });
}

/** Every signal `idle()` reads, as functions so the tests can fake each one independently. */
export interface IdleDeps {
  /** jobs.ts — a pipeline render, any match. */
  jobRunning: () => boolean;
  /** exportRoutes.ts — an encode, which is also a series game's export and a sync fix's Re-encode. */
  exportRunning: () => boolean;
  /** shortsRoutes.ts — the Short's own render. */
  shortRunning: () => boolean;
  /** shortFlow.ts — the model's pick queue. */
  pickRunning: () => boolean;
  /** shortFlow.ts — the publish chain (render, upload the video, upload the Short). */
  chainRunning: () => boolean;
  /** youtubeUpload.ts — an upload actually sending bytes in this process. */
  uploadRunning: () => boolean;
  /** A `.upload-session-*.json` on disk: a cut-short upload `shortTick` would resume next tick. */
  uploadSessionFile: () => boolean;
  /** archive.ts — an rsync to the NAS. */
  archiveRunning: () => boolean;
  /** nightly.ts — between a chained render's job settling and the next one's `startJob`, where a
   *  live suggestion scan/pickContext can run with no job and no export yet in flight. */
  nightlyChainRunning: () => boolean;
  /** rerender.ts — a thumbnail re-render or a new tile's "Use this", any match. */
  thumbnailRunning: () => boolean;
  /** youtubeStore.ts — a Finish or a Put/Undo on YouTube writing the video, any match. */
  videoWriting: () => boolean;
  /** `config.nightlyRenderHourUtc`, read fresh since the Settings tab can move it without a restart. */
  nightlyHourUtc: number | null;
}

const liveDeps = (): IdleDeps => ({
  jobRunning: anyJobRunning,
  exportRunning: anyExportRunning,
  shortRunning: anyShortRunning,
  pickRunning: picksRunning,
  chainRunning: chainsRunning,
  uploadRunning: anyUploadRunning,
  uploadSessionFile: () => anyUploadSessionFile(),
  archiveRunning: () => allArchiveStates().some((a) => a.running),
  nightlyChainRunning,
  thumbnailRunning: anyThumbnailRunning,
  videoWriting: anyVideoWriting,
  nightlyHourUtc: config.nightlyRenderHourUtc,
});

/**
 * Every reason to keep waiting, in the order checked — empty means idle. Worded for the operator
 * (the nightly strip and `GET`'s `blockedBy`), not for the dependency that reads it.
 */
export function blockedBy(deps: IdleDeps, nowMs: number = Date.now()): string[] {
  const blockers: string[] = [];
  if (deps.jobRunning()) blockers.push("a render is running");
  if (deps.exportRunning()) blockers.push("an export is running");
  if (deps.shortRunning()) blockers.push("a Short is rendering");
  if (deps.pickRunning()) blockers.push("the model is picking a Short's moment");
  if (deps.chainRunning()) blockers.push("the publish chain is running");
  if (deps.uploadRunning()) blockers.push("an upload is running");
  if (deps.uploadSessionFile()) blockers.push("an upload session is still on disk");
  if (deps.archiveRunning()) blockers.push("an archive copy to the NAS is running");
  if (deps.nightlyChainRunning()) blockers.push("a nightly chain is between renders");
  if (deps.thumbnailRunning()) blockers.push("a thumbnail re-render is running");
  if (deps.videoWriting()) blockers.push("a Finish or Put on YouTube is writing");
  if (deps.nightlyHourUtc !== null && msUntilNextRun(nowMs, deps.nightlyHourUtc) <= NIGHTLY_GUARD_MS) {
    blockers.push("within 20 min of the nightly render");
  }
  return blockers;
}

/** Whether every one of `blockedBy`'s reasons is clear right now. */
export const idle = (deps: IdleDeps = liveDeps(), nowMs: number = Date.now()): boolean =>
  blockedBy(deps, nowMs).length === 0;

export interface RestartState {
  armedAt: string;
  lastCheck: string | null;
  blockedBy: string[];
  /** The boot check's own failure, kept here until a fresh POST or a DELETE clears it. */
  error?: string;
}

let armedAtMs: number | null = null;
let lastCheckMs: number | null = null;
let lastBlockedBy: string[] = [];
let lastError: string | undefined;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let expireTimer: ReturnType<typeof setTimeout> | null = null;

/** The pending restart's state for `GET /api/restart-when-idle` and the nightly strip, or null. */
export function restartState(): RestartState | null {
  if (armedAtMs === null) return null;
  return {
    armedAt: new Date(armedAtMs).toISOString(),
    lastCheck: lastCheckMs === null ? null : new Date(lastCheckMs).toISOString(),
    blockedBy: lastBlockedBy,
    ...(lastError ? { error: lastError } : {}),
  };
}

/** `npx tsc --noEmit`, argv array, no shell — the same check `ship`/CI run before anything merges. */
function runBootCheck(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsc", "--noEmit"],
      { cwd: process.cwd(), timeout: TSC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(null);
          return;
        }
        const out = (stderr || stdout || err.message).trim();
        resolve(out === "" ? err.message : out.slice(-4000));
      },
    );
  });
}

/**
 * The seams `armRestart` can be given: the real timings and the real boot check in production,
 * fast ones and a stand-in in tests — the same shape as `NightlyDeps`/`ChainDeps` elsewhere in
 * this file's neighbours, so the tests need no fake clock.
 */
export interface ArmOptions {
  checkIntervalMs: number;
  expireMs: number;
  idleDeps: () => IdleDeps;
  bootCheck: () => Promise<string | null>;
  /** `process.exit` in production; the tests' seam for the one call that actually stops the
   *  process, so the exit path itself — not just the state leading up to it — is pinned. */
  exit: (code: number) => void;
}

const defaultOptions = (): ArmOptions => ({
  checkIntervalMs: CHECK_INTERVAL_MS,
  expireMs: EXPIRE_MS,
  idleDeps: liveDeps,
  bootCheck: runBootCheck,
  exit: (code) => process.exit(code),
});

let active: ArmOptions = defaultOptions();

function stopChecking(): void {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

function startChecking(): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => void tick().catch(onTickError), active.checkIntervalMs);
  // Never the reason the process cannot exit — exiting cleanly is the entire point of this file.
  checkTimer.unref?.();
}

function onTickError(err: unknown): void {
  const message = describeError(err);
  console.error(`restart-when-idle: ${message}`);
  // Same treatment as a failed boot check: kept on the state until a fresh POST or a DELETE, so
  // GET and the nightly strip show something is actually wrong rather than the calm "waiting
  // for: …" line with a stale blockedBy (a broken signal function must not look like busy-ness).
  lastError = message;
}

async function tick(): Promise<void> {
  const nowMs = Date.now();
  lastCheckMs = nowMs;
  lastBlockedBy = blockedBy(active.idleDeps(), nowMs);
  if (lastBlockedBy.length > 0) return;

  // Idle: pause the 30 s poll rather than let a second one start on top of a boot check that can
  // run for up to five minutes.
  stopChecking();
  const armedAt = armedAtMs;
  const error = await active.bootCheck();
  // A DELETE (or a fresh POST) while tsc ran: this tick speaks for an arm that no longer exists —
  // no exit, no stale error, no poll resurrected for a cancelled arm. A fresh POST runs its own.
  if (armedAtMs !== armedAt) return;
  if (error) {
    lastError = error;
    console.error(`restart-when-idle: boot check failed, staying up — ${error.split("\n")[0]}`);
    // Left paused on purpose ("disarm"): hammering a failing tsc every 30 s would only spam the
    // log. armedAtMs stays set so the error keeps showing until a fresh POST (the code is fixed)
    // or a DELETE (cancel) — the expiry timer below still clears it after 6 h either way.
    return;
  }

  // tsc can run for minutes; re-read idle() once more right before exiting in case something
  // started during it — a render clicked mid-check must not be cut off a moment later.
  const final = blockedBy(active.idleDeps(), Date.now());
  if (final.length > 0) {
    lastBlockedBy = final;
    startChecking();
    return;
  }

  console.log(
    `restart-when-idle: idle and the boot check passed — restarting into ${repoHead() ?? "unknown"}`,
  );
  // setImmediate rather than exiting inline, so the log line above is flushed before the process
  // actually goes down.
  setImmediate(() => active.exit(0));
}

/**
 * Arms a pending restart. Idempotent: a second press just resets the clock and any past error.
 * `overrides` is the tests' seam only — the server route always calls this with none, which is
 * the real timings against the real idle signals and a real `tsc --noEmit`.
 */
export function armRestart(overrides: Partial<ArmOptions> = {}): RestartState {
  stopChecking();
  if (expireTimer) clearTimeout(expireTimer);
  active = { ...defaultOptions(), ...overrides };
  armedAtMs = Date.now();
  lastCheckMs = null;
  lastBlockedBy = [];
  lastError = undefined;
  startChecking();
  expireTimer = setTimeout(() => {
    console.error(
      `restart-when-idle: still not idle after ${Math.round(active.expireMs / 3_600_000)} h — the arm expired`,
    );
    disarmRestart();
  }, active.expireMs);
  expireTimer.unref?.();
  return restartState() as RestartState;
}

/** Cancels a pending restart outright. Returns whether one was actually armed — the DELETE route. */
export function disarmRestart(): boolean {
  const was = armedAtMs !== null;
  stopChecking();
  if (expireTimer) clearTimeout(expireTimer);
  expireTimer = null;
  armedAtMs = null;
  lastCheckMs = null;
  lastBlockedBy = [];
  lastError = undefined;
  return was;
}
