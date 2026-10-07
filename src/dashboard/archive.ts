/**
 * Copying a published match to the NAS, and reporting how much room is left.
 *
 * Deliberately a copy, never a move: nothing is deleted. That is the policy, and it has a
 * consequence worth stating rather than discovering at 95% — archiving does NOT reclaim the lab
 * SSD. A finished match is 2–2.5 GB (two POV clips and the final MP4; the overlay artifacts are a
 * few MB), so the SSD fills at that rate however diligently this runs. The NAS copy is a backup;
 * freeing space stays a separate, manual decision.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { warsawParts } from "../telegram/schedule.js";

/** Where the NAS is mounted inside the container. See compose.yaml. */
const ARCHIVE_ROOT = process.env.MCSR_ARCHIVE_DIR ?? "/archive";

/**
 * NAS transfers run only in this Warsaw wall-clock window — the disks are audible in the
 * operator's home at night (the operator, 1 Oct 2026: "make the transfers to the nas only after
 * 3am as it's a bit loud"). DST-correct via `warsawParts` (src/telegram/schedule.ts).
 */
const NAS_WINDOW_START_H = 3;
const NAS_WINDOW_END_H = 8;

export function inNasWindow(nowMs: number = Date.now()): boolean {
  const { h } = warsawParts(nowMs);
  return h >= NAS_WINDOW_START_H && h < NAS_WINDOW_END_H;
}

/**
 * Cached in memory, never a TTL: true is permanent (an archive is never deleted, so a stat that
 * found one stays valid forever); a cached false is refreshed only by `archiveMatch` itself on a
 * successful copy, or by `refreshArchived` (the nightly sweep's ground-truth read, which must
 * notice a copy made outside this process rather than trust a memoized false forever). A polled
 * GET must never reach the CIFS mount on every request, so `isArchived` alone never re-stats.
 */
const archivedCache = new Map<number, boolean>();

function readArchived(matchId: number): boolean {
  const fresh = existsSync(path.join(ARCHIVE_ROOT, String(matchId)));
  archivedCache.set(matchId, fresh);
  return fresh;
}

/** True when a copy of this match is on the NAS, i.e. a delete of it would be recoverable. */
export function isArchived(matchId: number): boolean {
  return archivedCache.get(matchId) ?? readArchived(matchId);
}

/** Bypasses the cache — only the nightly sweep should need to, to decide what still needs a copy. */
export function refreshArchived(matchId: number): boolean {
  return readArchived(matchId);
}

export interface ArchiveState {
  matchId: number;
  running: boolean;
  error: string | null;
  /** null until a run finishes; milliseconds. */
  tookMs: number | null;
}

const states = new Map<number, ArchiveState>();

export const allArchiveStates = (): ArchiveState[] => [...states.values()];

/**
 * One copy at a time. The first channel scan after a restart can pair a dozen Studio uploads at
 * once (src/youtube/youtubeUpload.ts), and a dozen concurrent rsyncs over the CIFS mount are slower than
 * one and can time the mount out. A queued match reports `running` from the moment it is asked
 * for — from the operator's side it is in flight either way.
 *
 * ponytail: one global queue. Per-destination queues if a second archive target ever appears.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * rsync rather than cp: the NAS is a CIFS mount that can return an I/O error mid-write, and
 * rsync resumes instead of leaving a truncated file behind. Fire-and-forget: a match over the
 * CIFS mount takes minutes, which an upload response should not wait on.
 *
 * `now` is threaded through to the eventual spawn (not just checked here) so a queue backed up
 * past the quiet window's end re-checks the clock on every item's turn, not just at the moment
 * it was queued — see `copyToArchive`. Defaults to the real clock; only tests override it.
 */
export function archiveMatch(matchId: number, now: () => number = Date.now): ArchiveState {
  const existing = states.get(matchId);
  if (existing?.running) return existing;
  // Outside 03:00-08:00 Warsaw: do nothing — not even the isArchived stat below — and say so.
  // Checked before isArchived so a cache miss here costs no existsSync on the mount; an automatic
  // call (after an upload, any hour) must not touch it at all. The nightly sweep only calls this
  // from inside the window in the first place (src/dashboard/nightly.ts), so this mainly catches
  // the former.
  if (!inNasWindow(now())) {
    console.error(`archive of #${matchId} deferred to the 03:00 Warsaw window`);
    return existing ?? { matchId, running: false, error: null, tookMs: null };
  }
  // Already backed up: nothing to do. Here rather than at each caller because every one of them
  // is "this match is published, keep it" and would otherwise need the same test — the channel
  // scan re-pairs a Studio upload whenever its record is missing, and a re-upload of a re-export
  // would queue a second walk of 2.5 GB over CIFS for no change.
  //
  // ponytail: existence, not completeness — an rsync that died half way leaves a directory that
  // reads as archived. Remove `<ARCHIVE_ROOT>/<id>` to force a fresh copy.
  if (isArchived(matchId)) return existing ?? { matchId, running: false, error: null, tookMs: null };

  const state: ArchiveState = { matchId, running: true, error: null, tookMs: null };
  states.set(matchId, state);
  queue = queue.then(() => copyToArchive(state, now));
  return state;
}

/** Resolves when this match's rsync has finished, however it finished — the queue's turnstile. */
function copyToArchive(state: ArchiveState, now: () => number): Promise<void> {
  return new Promise((resolve) => {
    const { matchId } = state;
    // Re-checked here, not just in archiveMatch: a sweep can queue far more than one window can
    // carry, and the match behind the one currently copying must stop and wait for tomorrow's
    // sweep rather than start a fresh rsync past 08:00.
    if (!inNasWindow(now())) {
      state.running = false;
      console.error(`archive of #${matchId} deferred to the 03:00 Warsaw window`);
      resolve();
      return;
    }
    const startedAt = Date.now();
    const src = `${path.resolve(config.mediaDir, String(matchId))}/`;
    const dest = `${path.join(ARCHIVE_ROOT, String(matchId))}/`;
    // --partial so an interrupted transfer resumes rather than restarting the biggest clip.
    // --exclude studio-*.png: the Studio pin step's before/after screenshots of the public watch
    // page (src/youtube/studioActions.ts `shot()`) — one more copy of "this Google account is
    // signed in here" than the profile-isolation design intends, and publishSet.ts's own bundle
    // already leaves them out the same way (its RSYNC_INCLUDES allowlist never names them).
    const proc = spawn("rsync", ["-a", "--partial", "--exclude", "studio-*.png", src, dest], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    proc.on("close", (code) => {
      state.running = false;
      state.tookMs = Date.now() - startedAt;
      if (code !== 0) state.error = stderr.trim().split("\n").slice(-1)[0] || `rsync exited ${code}`;
      else archivedCache.set(matchId, true); // known good without another stat.
      console.error(
        state.error
          ? `archive ${matchId}: FAILED — ${state.error}`
          : `archive ${matchId}: done in ${Math.round(state.tookMs / 1000)}s`,
      );
      resolve();
    });

    proc.on("error", (err) => {
      state.running = false;
      state.error = err.message;
      state.tookMs = Date.now() - startedAt;
      console.error(`archive ${matchId}: FAILED — ${err.message}`);
      resolve();
    });
  });
}

export interface Capacity {
  path: string;
  freeBytes: number;
  totalBytes: number;
  /** Roughly how many more matches fit, at 3 GB each. */
  matchesLeft: number;
}

// Measured 1.9–2.4 GB on the shelf (two POV clips and the final MP4); budgeted with headroom.
const MATCH_BYTES = 3 * 1024 ** 3;

async function capacityOf(target: string): Promise<Capacity | null> {
  try {
    const fs = await statfs(target);
    const freeBytes = fs.bavail * fs.bsize;
    return {
      path: target,
      freeBytes,
      totalBytes: fs.blocks * fs.bsize,
      matchesLeft: Math.floor(freeBytes / MATCH_BYTES),
    };
  } catch {
    // The NAS is not mounted on a desktop checkout, and a soft CIFS mount can vanish. Missing
    // capacity is not worth failing a dashboard request over.
    return null;
  }
}

const ARCHIVE_CAPACITY_TTL_MS = 30 * 60 * 1000;
let archiveCapacityCache: { atMs: number; value: Capacity | null } | null = null;

/**
 * Both tiers, because archiving fills the NAS but never drains the SSD. The working tier (the
 * SSD `/media` is on) is always a fresh statfs. The archive tier is a CIFS statfs across the
 * same mount the quiet window protects, and this is polled on every GET /api/nightly and
 * /api/capacity, so it is cached for 30 minutes rather than read on every request.
 */
export async function capacity(
  nowMs: number = Date.now(),
): Promise<{ working: Capacity | null; archive: Capacity | null }> {
  const workingP = capacityOf(config.mediaDir);
  if (!archiveCapacityCache || nowMs - archiveCapacityCache.atMs >= ARCHIVE_CAPACITY_TTL_MS) {
    archiveCapacityCache = { atMs: nowMs, value: await capacityOf(ARCHIVE_ROOT) };
  }
  return { working: await workingP, archive: archiveCapacityCache.value };
}
