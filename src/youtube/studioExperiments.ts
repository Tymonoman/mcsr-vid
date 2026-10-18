/**
 * `<mediaDir>/.experiments.json` — owned by the dashboard's experiment engine
 * (`src/dashboard/experiments.ts`, merged into `main` 8 Oct 2026). This module only ever reads
 * the whole file and writes `kind: "tc"` entries back into it (read-merge-write, atomic
 * write-then-rename): a `between` entry, or any field on the file this module does not know
 * about — `baseline`, `appliedOn`, `evaluatedOn`, the engine's own once-a-day guards, or anything
 * a future writer adds — is passed through untouched. It is someone else's data that happens to
 * share this file.
 *
 * `readExperiments`/`writeExperiments` below used to reconstruct the file as `{ experiments,
 * schedule }` only, which silently dropped every other top-level field on every single write —
 * `baseline`/`appliedOn`/`evaluatedOn` included (review fix, 8 Oct 2026: `updateTcExperiments` ran
 * on `main` the same night the engine's own `applyScheduledRenderArm` started relying on
 * `appliedOn` to never re-apply a night's render arm twice, so losing it on any `tc`-plan or
 * worker write would have silently re-applied last night's settings patch). They now carry the
 * whole parsed object through (`{ ...parsed, experiments, schedule }`, validated only enough to
 * guarantee those two are real arrays) rather than reconstructing a narrow shape the dashboard's
 * own richer `ExperimentsFile` (`src/dashboard/experiments.ts`) does not share — that richer type
 * requires `hypothesis`/`metric`/`start`/`end` on every `Experiment`, which a `tc` entry never
 * sets, so importing it directly here would not type-check against what `planTcExperiments`
 * actually builds. This is the "raw read-merge-write" alternative instead: same losslessness,
 * without fighting that mismatch.
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
  /** A title arm's style ("meme"/"tech"/"setting"/"tease"/"nicknames", from `title-options.json`'s
   *  own `styles`, else "unknown"). The control arm gets one too — the cache option its own saved
   *  hook matches, else "picked" — so `src/cli/abReport.ts`'s aggregation can say whether the
   *  operator's own pick beat the styles it skipped. Absent on an arm from before 18 Oct 2026
   *  (`planTcExperiments`'s own single-challenger title branch, or any thumbnail arm). */
  style?: string;
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
  /** `baseline`, `appliedOn`, `evaluatedOn` (`src/dashboard/experiments.ts`'s own fields) and
   *  anything else a future writer adds — never read or written by name here, only round-tripped. */
  [key: string]: unknown;
}

const filePath = (): string => path.join(config.mediaDir, ".experiments.json");

export async function readExperiments(): Promise<ExperimentsFile> {
  const file = filePath();
  if (!existsSync(file)) return { experiments: [], schedule: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // A corrupt file from another writer mid-save must not read as "no experiments" — that would
    // silently re-plan or re-start whatever this run thinks is missing.
    throw new Error(`${file} did not parse as JSON: ${(err as Error).message}`);
  }
  return {
    ...parsed,
    experiments: Array.isArray(parsed.experiments) ? (parsed.experiments as Experiment[]) : [],
    schedule: Array.isArray(parsed.schedule) ? (parsed.schedule as unknown[]) : [],
  };
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

/**
 * Pure transform: approved plan entries into planned `"tc"` `Experiment`s, one per video per
 * kind. Deterministic ids (`tc-thumbnail-<videoId>`, `tc-title-<videoId>`) are the whole
 * idempotency mechanism — `existingIds` is just "what the file already has", no separate dedupe
 * pass. A title variant is run through `titleTestProblem`, the same refusal `startTestAndCompare`
 * applies later, so nothing gets planned that could never be started; an entry with every variant
 * refused is skipped entirely rather than planned with zero challengers. A title test only ever
 * gets one challenger arm, the first variant to pass (8 Oct 2026) — Title-only mode's own dialog
 * has exactly one challenger slot (live + 1, CLAUDE.md's "Phase 2/3" facts), so a plan with more
 * than one surviving variant would otherwise be planned with an arm `startTestAndCompare` has no
 * slot to fill. A thumbnail entry's own variant files are used exactly as given — every one of
 * them is already the final, judged render (`tc-thumbs`'s own output, or a human judge's
 * approved set), never rewritten to some other file on disk (dropped 8 Oct 2026: the one-off
 * `tc-pose.png`→strip-file substitution this used to do existed only for a single night's plan
 * whose `tc/` files were about to be re-rendered out from under it; every plan since stands on
 * its own files).
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
    const files = entry.variants;
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
    // Exactly one challenger — the first variant to pass (see this function's own doc comment).
    // Every variant is still checked and a failing one still logged, so a bad first suggestion
    // never silently hides a usable second one; a passing variant past the first is simply not
    // needed and is neither used nor logged.
    let challenger: { name: string; title: string } | null = null;
    for (const hook of entry.variants) {
      const title = `${hook}${SEPARATOR}${rest}`;
      const problem = titleTestProblem(title, players);
      if (problem) {
        skipped.push({ videoId: entry.videoId, kind: "title", reason: `"${hook}": ${problem}` });
        continue;
      }
      if (!challenger) challenger = { name: "challenger1", title };
    }
    if (!challenger) continue; // every variant refused; already logged above
    added.push({
      id,
      kind: "tc",
      variable: "title",
      controlArm: "control",
      arms: [
        { name: "control", settings: { title: entry.live } },
        { name: challenger.name, settings: { title: challenger.title } },
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
