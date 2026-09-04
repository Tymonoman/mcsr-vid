/**
 * Copying a published match to the NAS, and reporting how much room is left.
 *
 * Deliberately a copy, never a move: nothing is deleted. That is the policy, and it has a
 * consequence worth stating rather than discovering at 95% — archiving does NOT reclaim the lab
 * SSD. A finished match is ~7 GB (a 5.7 GB ProRes 4444 overlay, a 280 MB intro, two POV clips,
 * the final MP4), so the SSD fills at that rate however diligently this runs. The NAS copy is a
 * backup; freeing space stays a separate, manual decision.
 */
import { spawn } from "node:child_process";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** Where the NAS is mounted inside the container. See compose.yaml. */
const ARCHIVE_ROOT = process.env.MCSR_ARCHIVE_DIR ?? "/archive";

export interface ArchiveState {
  matchId: number;
  running: boolean;
  error: string | null;
  /** null until a run finishes; milliseconds. */
  tookMs: number | null;
}

const states = new Map<number, ArchiveState>();

export const archiveState = (matchId: number): ArchiveState | undefined => states.get(matchId);
export const allArchiveStates = (): ArchiveState[] => [...states.values()];

/**
 * rsync rather than cp: the NAS is a CIFS mount that can return an I/O error mid-write, and
 * rsync resumes instead of leaving a truncated file behind. Fire-and-forget — ~7 GB at the
 * measured 17.7 MB/s is about seven minutes, which an upload response should not wait on.
 */
export function archiveMatch(matchId: number): ArchiveState {
  const existing = states.get(matchId);
  if (existing?.running) return existing;

  const state: ArchiveState = { matchId, running: true, error: null, tookMs: null };
  states.set(matchId, state);

  const startedAt = Date.now();
  const src = `${path.resolve(config.mediaDir, String(matchId))}/`;
  const dest = `${path.join(ARCHIVE_ROOT, String(matchId))}/`;
  // --partial so an interrupted transfer resumes rather than restarting the 5.7 GB overlay.
  const proc = spawn("rsync", ["-a", "--partial", src, dest], {
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
    console.error(
      state.error
        ? `archive ${matchId}: FAILED — ${state.error}`
        : `archive ${matchId}: done in ${Math.round(state.tookMs / 1000)}s`,
    );
  });

  proc.on("error", (err) => {
    state.running = false;
    state.error = err.message;
    state.tookMs = Date.now() - startedAt;
    console.error(`archive ${matchId}: FAILED — ${err.message}`);
  });

  return state;
}

export interface Capacity {
  path: string;
  freeBytes: number;
  totalBytes: number;
  /** Roughly how many more matches fit, at ~7 GB each. */
  matchesLeft: number;
}

const MATCH_BYTES = 7 * 1024 ** 3;

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

/** Both tiers, because archiving fills the NAS but never drains the SSD. */
export async function capacity(): Promise<{ working: Capacity | null; archive: Capacity | null }> {
  const [working, archive] = await Promise.all([capacityOf(config.mediaDir), capacityOf(ARCHIVE_ROOT)]);
  return { working, archive };
}
