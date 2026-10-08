/**
 * `<mediaDir>/.experiments.json` — owned by the dashboard's experiment engine (branch
 * `exp-engine`, not merged yet). This module only ever reads the whole file and writes `kind:
 * "tc"` entries back into it (read-merge-write, atomic write-then-rename): a `between` entry, or
 * any field on the file this module does not know about, is passed through untouched — it is
 * someone else's data that happens to share this file.
 *
 * `updateTcExperiments` is this module's own read-merge-write entry point, and it is reached
 * from two separate OS processes (the standalone `npm run studio -- worker`'s own cycles, and a
 * one-off `tc-plan`/`endscreen`/`tc` CLI invocation run alongside it) — unlike every other
 * read-merge-write file in this codebase (`.dashboard.json`, `short-<id>.status.json`, …), which
 * this repo's own convention leans on "there is only ever one dashboard process" for. That
 * assumption does not hold here, so a write landing between another writer's read and write
 * would otherwise be silently lost. `withExperimentsLock` below is a plain `wx`-flag lockfile,
 * not a true cross-platform advisory lock — ponytail: good enough for two cooperating processes
 * on one filesystem; upgrade to a real lock (or a version/hash compare-and-swap before the
 * rename) if a third writer that does not honour this lockfile shows up (CLAUDE.md's review
 * note, 8 Oct 2026).
 */
import { existsSync, mkdirSync } from "node:fs";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { SEPARATOR } from "../pipeline/title.js";
import { titleTestProblem } from "./studioActions.js";
import { splitTitle } from "./youtubeStore.js";

export interface ExperimentArm {
  name: string;
  settings?: unknown;
  slot?: unknown;
}

export interface ExperimentVideoRef {
  videoId?: string;
  matchId: number;
  arm: string;
}

export interface Experiment {
  id: string;
  kind: "between" | "tc";
  hypothesis?: string;
  variable?: string;
  metric?: string;
  controlArm?: string;
  arms: ExperimentArm[];
  videos: ExperimentVideoRef[];
  start?: string | null;
  end?: string | null;
  status: "planned" | "running" | "done";
  result?: unknown;
  verdict?: string | null;
  decision?: string | null;
  needsHuman?: string | null;
  needsHumanAck?: boolean;
}

export interface ExperimentsFile {
  experiments: Experiment[];
  schedule: unknown[];
}

const filePath = (): string => path.join(config.mediaDir, ".experiments.json");

export async function readExperiments(): Promise<ExperimentsFile> {
  const file = filePath();
  if (!existsSync(file)) return { experiments: [], schedule: [] };
  let parsed: Partial<ExperimentsFile>;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ExperimentsFile>;
  } catch (err) {
    // A corrupt file from another writer mid-save must not read as "no experiments" — that would
    // silently re-plan or re-start whatever this run thinks is missing.
    throw new Error(`${file} did not parse as JSON: ${(err as Error).message}`);
  }
  return { experiments: parsed.experiments ?? [], schedule: parsed.schedule ?? [] };
}

export async function writeExperiments(file: ExperimentsFile): Promise<void> {
  mkdirSync(config.mediaDir, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, target);
}

const lockPath = (): string => `${filePath()}.lock`;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
/** A read-merge-write here never takes anywhere near this long; a lock still held this long is a
 * crashed holder's leftover, not a slow one's, so it is safe to break. */
const LOCK_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process mutex for `.experiments.json`'s read-merge-write, so this worker process and a
 * one-off CLI invocation run alongside it cannot interleave a read and a write and silently lose
 * one of them (see this module's own top-of-file comment). An exclusive `wx` create is the lock;
 * a stale one (its holder crashed mid-section, never reaching the `finally` below) is broken and
 * retried rather than wedging every future write forever.
 */
async function withExperimentsLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(config.mediaDir, { recursive: true });
  const lock = lockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(lock, "wx");
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > LOCK_STALE_MS) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lock}: timed out waiting for the experiments-file lock`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/**
 * Read-merge-write for the `tc` entries only: `mutate` sees just the current `tc` list and
 * returns the list it wants written back; every `between` entry and every other top-level field
 * the file already carries passes through unchanged, so a caller here can never drop data it did
 * not ask to touch. The whole read-merge-write is one critical section (`withExperimentsLock`),
 * so a concurrent call — in this process or another — waits rather than racing it.
 */
export async function updateTcExperiments(
  mutate: (tc: Experiment[]) => Experiment[],
): Promise<ExperimentsFile> {
  return withExperimentsLock(async () => {
    const file = await readExperiments();
    const tc = file.experiments.filter((e) => e.kind === "tc");
    const other = file.experiments.filter((e) => e.kind !== "tc");
    const next: ExperimentsFile = { ...file, experiments: [...other, ...mutate(tc)] };
    await writeExperiments(next);
    return next;
  });
}

export interface TcPlanThumbEntry {
  matchId: number;
  videoId: string;
  variants: string[];
  approved: boolean;
  note?: string;
}

export interface TcPlanTitleEntry {
  videoId: string;
  matchId: number;
  live: string;
  variants: string[];
  approved: boolean;
}

export interface TcPlan {
  thumbnails?: TcPlanThumbEntry[];
  titles?: TcPlanTitleEntry[];
}

export interface TcPlanSkip {
  videoId: string;
  kind: "thumbnail" | "title";
  reason: string;
}

const POSE_NAMES = ["walking-crossed", "default-default", "cheering-relaxing", "marching-crouching"];

/**
 * A pose-challenger file under `<id>/tc/tc-pose.png` rewritten to its STRIP equivalent
 * (`<id>/thumbnail.<pose>.png`) — the one substitution the operator's brief asked for, because
 * another job re-renders `tc/*.png` tonight and the strip files are not part of that run. Any
 * other variant path (`tc-control.png`, `tc-caption.png`, or one already pointing at the strip)
 * passes through unchanged — nobody asked for those to move. Null when the path is a pose
 * challenger but its note names no pose this function recognises.
 */
function resolveThumbnailVariant(variantPath: string, note: string | undefined): string | null {
  if (!/\/tc\/tc-pose\.png$/.test(variantPath)) return variantPath;
  const pose = POSE_NAMES.find((p) => note?.includes(p));
  if (!pose) return null;
  const dir = path.dirname(path.dirname(variantPath));
  return path.join(dir, `thumbnail.${pose}.png`);
}

/**
 * Pure transform: approved plan entries into planned `"tc"` `Experiment`s, one per video per
 * kind. Deterministic ids (`tc-thumbnail-<videoId>`, `tc-title-<videoId>`) are the whole
 * idempotency mechanism — `existingIds` is just "what the file already has", no separate dedupe
 * pass. A title variant is run through `titleTestProblem`, the same refusal `startTestAndCompare`
 * applies later, so nothing gets planned that could never be started; an entry with every variant
 * refused is skipped entirely rather than planned with zero challengers.
 */
export function planTcExperiments(
  plan: TcPlan,
  existingIds: ReadonlySet<string>,
): { added: Experiment[]; skipped: TcPlanSkip[] } {
  const added: Experiment[] = [];
  const skipped: TcPlanSkip[] = [];

  for (const entry of plan.thumbnails ?? []) {
    const id = `tc-thumbnail-${entry.videoId}`;
    if (existingIds.has(id)) continue;
    if (!entry.approved) {
      skipped.push({ videoId: entry.videoId, kind: "thumbnail", reason: "not approved" });
      continue;
    }
    const resolved = entry.variants.map((v) => resolveThumbnailVariant(v, entry.note));
    const unresolvedAt = resolved.indexOf(null);
    if (unresolvedAt >= 0) {
      skipped.push({
        videoId: entry.videoId,
        kind: "thumbnail",
        reason: `variant ${unresolvedAt + 1} is a pose challenger under tc/ with no known pose named in its note`,
      });
      continue;
    }
    const files = resolved as string[];
    if (files.length < 2) {
      skipped.push({ videoId: entry.videoId, kind: "thumbnail", reason: "fewer than 2 variants" });
      continue;
    }
    added.push({
      id,
      kind: "tc",
      variable: "thumbnail",
      controlArm: "control",
      arms: files.map((file, i) => ({ name: i === 0 ? "control" : `challenger${i}`, settings: { file } })),
      videos: [{ videoId: entry.videoId, matchId: entry.matchId, arm: "tc" }],
      status: "planned",
    });
  }

  for (const entry of plan.titles ?? []) {
    const id = `tc-title-${entry.videoId}`;
    if (existingIds.has(id)) continue;
    if (!entry.approved) {
      skipped.push({ videoId: entry.videoId, kind: "title", reason: "not approved" });
      continue;
    }
    const parts = splitTitle(entry.live);
    if (!parts) {
      skipped.push({
        videoId: entry.videoId,
        kind: "title",
        reason: `live title has no "<a> vs <b>": ${entry.live}`,
      });
      continue;
    }
    const rest = entry.live.slice(parts.hook.length + (parts.hook ? SEPARATOR.length : 0));
    const players = [{ nickname: parts.left }, { nickname: parts.right }];
    const challengers: { name: string; title: string }[] = [];
    entry.variants.forEach((hook, i) => {
      const title = `${hook}${SEPARATOR}${rest}`;
      const problem = titleTestProblem(title, players);
      if (problem) {
        skipped.push({ videoId: entry.videoId, kind: "title", reason: `"${hook}": ${problem}` });
        return;
      }
      challengers.push({ name: `challenger${i + 1}`, title });
    });
    if (challengers.length === 0) continue; // every variant refused; already logged above
    added.push({
      id,
      kind: "tc",
      variable: "title",
      controlArm: "control",
      arms: [
        { name: "control", settings: { title: entry.live } },
        ...challengers.map((c) => ({ name: c.name, settings: { title: c.title } })),
      ],
      videos: [{ videoId: entry.videoId, matchId: entry.matchId, arm: "tc" }],
      status: "planned",
    });
  }

  return { added, skipped };
}

/**
 * IO wrapper: imports `plan` into `<mediaDir>/.experiments.json`, read-merge-write. Idempotent —
 * a second run on the same plan adds nothing, since the ids it would produce are already there.
 */
export async function importTcPlan(plan: TcPlan): Promise<{ added: Experiment[]; skipped: TcPlanSkip[] }> {
  let result: { added: Experiment[]; skipped: TcPlanSkip[] } = { added: [], skipped: [] };
  await updateTcExperiments((tc) => {
    result = planTcExperiments(plan, new Set(tc.map((e) => e.id)));
    return [...tc, ...result.added];
  });
  return result;
}
