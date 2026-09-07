/**
 * Hiding and deleting match working directories from the dashboard.
 *
 * archive.ts states the standing policy — copy to the NAS, never move, never delete, "freeing
 * space stays a separate, manual decision". This is that manual decision, made explicit and
 * given a button, not a loosening of the policy. Two things keep it from being a footgun:
 *
 *   - a match with work in flight cannot be deleted, so a delete can never race a render that
 *     is still writing into the directory it is removing;
 *   - the reply says whether an archived copy exists, so the caller can tell a recoverable
 *     delete from a permanent one and warn accordingly.
 *
 * Hiding is the reversible option and the one the list uses by default: it only filters the
 * dashboard, and touches nothing on disk inside the match directory.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** Where the NAS is mounted inside the container. Same default as archive.ts. */
const ARCHIVE_ROOT = process.env.MCSR_ARCHIVE_DIR ?? "/archive";

/**
 * Dot-prefixed so `listProcessedMatchIds` — which takes every `^\d+$` *directory* — cannot
 * mistake it for a match, and kept in mediaDir so the state travels with the media it describes
 * rather than with the checkout.
 */
const statePath = () => path.join(config.mediaDir, ".dashboard.json");

interface ShelfState {
  hidden: number[];
}

function read(): ShelfState {
  const file = statePath();
  if (!existsSync(file)) return { hidden: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ShelfState>;
    return { hidden: (parsed.hidden ?? []).filter((n) => Number.isSafeInteger(n)) };
  } catch {
    // A corrupt preferences file must not take the dashboard down over a cosmetic setting.
    return { hidden: [] };
  }
}

export function hiddenMatchIds(): Set<number> {
  return new Set(read().hidden);
}

export function setHidden(matchId: number, hidden: boolean): void {
  const state = read();
  const next = state.hidden.filter((id) => id !== matchId);
  if (hidden) next.push(matchId);
  writeFileSync(statePath(), JSON.stringify({ hidden: next.sort((a, b) => a - b) }, null, 2));
}

export interface DeleteResult {
  matchId: number;
  bytesFreed: number;
  /** Whether `<ARCHIVE_ROOT>/<id>` exists, i.e. whether this delete was recoverable. */
  archived: boolean;
}

async function dirBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** True when an archived copy exists, so a delete can be reported as recoverable. */
export const isArchived = (matchId: number): boolean => existsSync(path.join(ARCHIVE_ROOT, String(matchId)));

/**
 * Removes a match's working directory, reporting what it freed.
 *
 * Callers must already have refused if work is in flight; this deliberately knows nothing about
 * the job registries, so it stays testable without standing one up.
 */
export async function deleteMatch(matchId: number): Promise<DeleteResult> {
  const dir = path.join(config.mediaDir, String(matchId));
  if (!existsSync(dir)) throw new Error(`No working directory for match ${matchId}`);

  const bytesFreed = await dirBytes(dir);
  const archived = isArchived(matchId);
  await rm(dir, { recursive: true, force: true });
  // A hidden flag for a directory that no longer exists is just litter.
  setHidden(matchId, false);
  return { matchId, bytesFreed, archived };
}
