/**
 * "Re-render thumbnails": every variant drawn again with today's design, for a match rendered
 * before it — including a Studio upload whose directory never had thumbnail files. The stills a
 * pipeline run finds on disk are kept (`variantStillReusable`), so without this a new layout only
 * ever reached matches rendered after it.
 *
 * Every re-render lands in its own folder, `thumbnail-new/`, and never touches the live set
 * (`thumbnail.png`, the variant PNGs, `thumbnail.json`): uploads, Finish, the channel scan, the A/B
 * tab and the publish set read exactly what they read before. Only a press changes anything: on a
 * match on the channel "Put on YouTube" (src/youtube/thumbnailSwap.ts), on one that is not "Use
 * this" (`promoteNewSet`), which makes the new set the live one.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch, getUser } from "../api/mcsrApi.js";
import { blockedOnDisk } from "../dashboard/matchStatus.js";
import { describeError } from "../errorText.js";
import {
  manifestPath,
  readManifest,
  renderThumbnailVariants,
  type VariantsManifest,
} from "./thumbnailVariants.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";

export const NEW_DIR = "thumbnail-new";

export interface RerenderDeps {
  render?: typeof renderThumbnailVariants;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export async function rerenderThumbnails(
  matchId: number,
  deps: RerenderDeps = {},
): Promise<VariantsManifest> {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) throw new Error(`Match ${matchId} has no directory on this box`);
  // Same rule as every other render path (npm run short, the nightly): a blocked player's match
  // is never rendered, even by hand.
  if (blockedOnDisk(dir))
    throw new Error(`Match ${matchId} has a blocked player — its thumbnails are never rendered`);
  const match = await getMatch(matchId);
  const [left, right] = match.players;
  if (!left || !right) throw new Error(`Match ${matchId} does not have two players`);
  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  // Started afresh: a set cut short by a crash or a restart has no manifest, so it shows nothing
  // until a re-render lands one (each still is renamed into place whole; the manifest comes last).
  const outDir = path.join(dir, NEW_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir);
  return (deps.render ?? renderThumbnailVariants)({
    match,
    userLeft,
    userRight,
    outDir,
    poses: config.thumbnailVariants,
    fresh: true,
    onProgress: deps.onProgress,
    signal: deps.signal,
  });
}

/* --- Jobs: here rather than in the dashboard, so src/youtube/ can ask without reaching into it --- */

interface ThumbJob {
  matchId: number;
  line: string;
  since: string;
  percent?: number;
  done: boolean;
  error: string | null;
  finished: Promise<string | null>;
}

const jobs = new Map<number, ThumbJob>();
/** Matches whose new set is being moved over the live one (`promoteNewSet`). */
const promoting = new Set<number>();

export const thumbJob = (matchId: number): ThumbJob | undefined => jobs.get(matchId);
export const runningThumbJobs = (): ThumbJob[] => [...jobs.values()].filter((j) => !j.done);

/** A re-render or a "Use this" of the new set on this match: the long-form upload and Adopt refuse on it. */
export const thumbnailRunning = (matchId: number): boolean =>
  jobs.get(matchId)?.done === false || promoting.has(matchId);

/** Any in flight: the scheduled nightly waits it out before it starts (nightly.ts). */
export const anyThumbnailRunning = (): boolean => promoting.size > 0 || runningThumbJobs().length > 0;

/**
 * Four stills take a minute or two; one still drawing after this is hung (a Chromium that never
 * answers), and it would hold the bulk and the nightly behind it for ever. The signal cancels the
 * still render (`renderStill`) and ends the job, whatever the API reads, avatar fetches or bundling
 * before it are doing: they can only write into `thumbnail-new/`, which the next re-render empties.
 */
export const RERENDER_TIMEOUT_MS = 15 * 60_000;

export function startRerender(
  matchId: number,
  rerender: typeof rerenderThumbnails = rerenderThumbnails,
  timeoutMs = RERENDER_TIMEOUT_MS,
): ThumbJob {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;
  let settle!: (error: string | null) => void;
  const job: ThumbJob = {
    matchId,
    line: "reading the match",
    since: new Date().toISOString(),
    done: false,
    error: null,
    finished: new Promise((resolve) => (settle = resolve)),
  };
  jobs.set(matchId, job);
  const signal = AbortSignal.timeout(timeoutMs);
  const stopped = `stopped after ${Math.round(timeoutMs / 60_000)} min`;
  signal.addEventListener("abort", () => settle(stopped));
  rerender(matchId, {
    onProgress: (p) => {
      job.line = p.phase === "bundling" ? "bundling the compositions" : "rendering the variants";
      job.percent = p.percent;
    },
    signal,
  })
    .then(() => settle(null))
    .catch((err: unknown) => settle(signal.aborted ? stopped : describeError(err)));
  void job.finished.then((error) => {
    job.done = true;
    job.error = error;
    job.line = error ? "failed" : "done";
    if (error) console.error(`thumbnails ${matchId}: ${error}`);
  });
  return job;
}

/**
 * "Use this" on a tile of the new set, for a match not on the channel (the route checks that, and
 * that nothing else writes into the directory): the new stills are renamed over the live ones, the
 * pick is copied to `thumbnail.png`, and the live manifest is written last — the pressed key,
 * chosen by the operator, with the live manifest's frozen ranks and headline carried over.
 */
export async function promoteNewSet(matchId: number, key: string): Promise<VariantsManifest> {
  promoting.add(matchId);
  try {
    const dir = matchDir(matchId);
    if (blockedOnDisk(dir))
      throw new Error(`Match ${matchId} has a blocked player — its thumbnails are never rendered`);
    const from = path.join(dir, NEW_DIR);
    const fresh = await readManifest(from);
    const pick = fresh?.variants.find((v) => v.key === key);
    if (!fresh || !pick) throw new Error(`No new-design thumbnail "${key}" — re-render the thumbnails first`);
    const live = await readManifest(dir);
    for (const v of fresh.variants) await rename(path.join(from, v.file), path.join(dir, v.file));
    await copyFile(path.join(dir, pick.file), path.join(dir, "thumbnail.png"));
    const manifest: VariantsManifest = {
      ...fresh,
      chosen: key,
      chosenBy: "operator",
      hookText: live?.hookText ?? null,
      ranks: live?.ranks ?? fresh.ranks,
    };
    await writeFile(manifestPath(dir), JSON.stringify(manifest, null, 2), "utf8");
    await rm(from, { recursive: true, force: true });
    return manifest;
  } finally {
    promoting.delete(matchId);
  }
}
