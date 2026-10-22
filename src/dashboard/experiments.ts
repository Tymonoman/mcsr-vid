/**
 * The experiment engine: between-video A/B tests that run unattended, so the channel keeps
 * testing arms (publish hour, the Short's delay, `explainMovesSec`, `countdownTeaser`, `introSec`,
 * cadence) while nobody is watching the dashboard. The operator's /goal, 7 Oct 2026: "the
 * automation lives in the dashboard code, not this session: when the usage limit hits, the
 * channel keeps running."
 *
 * The data is `<mediaDir>/.experiments.json` — hypotheses, arms, a day-by-day schedule, and each
 * experiment's result once evaluated (`experimentsEvaluator.ts`). This file is everything that
 * *reads* it: what today's schedule entry says to do to a render and a publish slot, and the
 * readable summaries (`testsSummary` for the Telegram report, `renderExperimentsDoc` for `/ask`).
 * Nothing here decides which hypotheses to run or writes the schedule — that is the operator's
 * plan, or the Studio automation's own "tc" (Test & Compare) experiments on another branch, which
 * this file carries untouched: filtering by `kind !== "between"` is the evaluator's job
 * (`experimentsEvaluator.ts`), not this one's, since a schedule entry's `render`/`slot` patch is
 * applied the same way regardless of which experiment it names.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { saveSettings, SETTINGS } from "./settings.js";

export interface SlotArm {
  /** Ranked-video (never series) candidate publish hours UTC for this day, tried in order. */
  rankedHoursUtc?: number[];
  /** Hours after the long-form the Short follows, -6–48; negative is a teaser (the Short goes
   *  public that many hours BEFORE the long-form, x6); out of range is ignored. */
  shortDelayHours?: number;
}

export interface ExperimentArm {
  name: string;
  /** Settings keys this arm sets — applied through `saveSettings`, the only way this engine
   *  ever changes a setting. */
  settings?: Record<string, unknown>;
  slot?: SlotArm;
}

export interface ExperimentVideo {
  /** Filled in by the evaluator from the match's `youtube.json` when absent. */
  videoId?: string;
  matchId: number;
  arm: string;
}

export type ExperimentStatus = "planned" | "running" | "done";

export interface Experiment {
  id: string;
  /** "tc": Studio's Test & Compare, written by the automation on another branch — carried
   *  through every read and write here, never evaluated or adopted. */
  kind: "between" | "tc";
  hypothesis: string;
  variable: string;
  metric: string;
  controlArm: string;
  arms: ExperimentArm[];
  videos: ExperimentVideo[];
  /** YYYY-MM-DD, UTC. */
  start: string;
  end: string;
  status: ExperimentStatus;
  /** Adopt the winning arm's settings at `end`; otherwise the control arm's are kept. */
  adoptWinner?: boolean;
  result?: Record<string, unknown>;
  verdict?: string;
  decision?: string;
  needsHuman?: string;
  needsHumanAck?: boolean;
  /** RFC 3339, set each time the evaluator computes a fresh result — what "since the last
   *  report" (the Telegram summary) and the two-day failure streak below are measured against. */
  evaluatedAt?: string;
  /** The evaluator's own retry memory: the UTC date and message of the last failed attempt, so a
   *  second failure on the very next day's tick can set `needsHuman` instead of guessing or
   *  retrying silently forever. Cleared the next time evaluation succeeds. */
  lastEvalFailure?: { date: string; message: string };
}

export interface ScheduleEntry {
  /** YYYY-MM-DD, UTC. */
  date: string;
  experimentId: string;
  arm: string;
  /** Settings keys applied before that night's render (`applyScheduledRenderArm`). */
  render?: Record<string, unknown>;
  /** Applies to long-forms whose publish slot falls on this UTC date. */
  slot?: SlotArm;
}

export interface ExperimentsFile {
  baseline?: Record<string, unknown>;
  experiments: Experiment[];
  schedule: ScheduleEntry[];
  /** The UTC date `applyScheduledRenderArm` last applied — set whether or not that date had a
   *  render patch, so a restart or a later 15-minute tick never re-applies the same day twice. */
  appliedOn?: string;
  /** The UTC date the evaluator last ran — once a day, whatever it found. */
  evaluatedOn?: string;
}

const EMPTY: ExperimentsFile = { experiments: [], schedule: [] };

const filePath = (): string => path.join(config.mediaDir, ".experiments.json");

/** Missing or corrupt reads as "no experiments running", never a crash — this file is read on
 *  every publish-slot lookup and every 15-minute tick. */
export const readExperiments = (): ExperimentsFile => readExperimentsOrNull() ?? EMPTY;

/** The same read, but corrupt is `null`, not EMPTY — for a caller that writes the whole file back
 *  (`evaluateExperiments`), where reading a hand-edit's trailing comma as "nothing here" would
 *  overwrite every experiment, the schedule and the Studio "tc" records with an empty file. */
export function readExperimentsOrNull(): ExperimentsFile | null {
  const file = filePath();
  if (!existsSync(file)) return EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExperimentsFile>;
    return {
      ...(parsed.baseline !== undefined ? { baseline: parsed.baseline } : {}),
      experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
      ...(typeof parsed.appliedOn === "string" ? { appliedOn: parsed.appliedOn } : {}),
      ...(typeof parsed.evaluatedOn === "string" ? { evaluatedOn: parsed.evaluatedOn } : {}),
    };
  } catch (err) {
    console.error(`experiments: ${file} unreadable — ${describeError(err)}`);
    return null;
  }
}

/** Atomic (write-then-rename), as `short-<id>.status.json` is. */
export function writeExperiments(data: ExperimentsFile): void {
  const file = filePath();
  writeFileSync(`${file}.part`, JSON.stringify(data, null, 2));
  renameSync(`${file}.part`, file);
}

export const scheduleEntryFor = (
  date: string,
  data: ExperimentsFile = readExperiments(),
): ScheduleEntry | undefined => data.schedule.find((s) => s.date === date);

/**
 * A date's schedule entries can now number more than one — a render arm (`render`, applied
 * before that night's render) and slot arms (`slot`, publish hours / Short delay) of *different*
 * experiments all naming the same date. These helpers pick the entries tagged for the side
 * that's asking, falling back to the date's first entry not tagged for the *other* side — so an
 * untagged entry (every shape on disk before this existed) resolves exactly as `scheduleEntryFor`
 * always did, but a slot-only night never labels a render (`writeExperimentArmFile`), nor a
 * render-only date a publish (`enrolVideos`), with the other side's arm.
 *
 * Two slot experiments can share a date when each owns a different slot field (a publish-hour
 * experiment's `rankedHoursUtc` beside a Short-delay experiment's `shortDelayHours`, 22 Oct 2026):
 * every slot entry enrols (`enrolVideos`), and each lookup below takes the first entry that sets
 * its own field.
 */
export function slotEntriesFor(date: string, data: ExperimentsFile = readExperiments()): ScheduleEntry[] {
  const entries = data.schedule.filter((s) => s.date === date);
  const tagged = entries.filter((s) => s.slot);
  if (tagged.length) return tagged;
  const untagged = entries.find((s) => !s.render);
  return untagged ? [untagged] : [];
}

export const slotEntryFor = (
  date: string,
  data: ExperimentsFile = readExperiments(),
): ScheduleEntry | undefined => slotEntriesFor(date, data)[0];

function renderEntryFor(date: string, data: ExperimentsFile): ScheduleEntry | undefined {
  const entries = data.schedule.filter((s) => s.date === date);
  return entries.find((s) => s.render) ?? entries.find((s) => !s.slot);
}

/**
 * Sorted ranked-video (never series) candidate publish hours for a UTC date, or undefined when
 * nothing overrides it — `nextPublishSlot` then falls back to `config.publishHourUtc` alone,
 * exactly as before this existed.
 */
export function rankedHoursForDate(
  date: string,
  data: ExperimentsFile = readExperiments(),
): number[] | undefined {
  const hours: unknown = slotEntriesFor(date, data).find((s) => s.slot?.rankedHoursUtc)?.slot?.rankedHoursUtc;
  // Hand-edited, like shortDelayHours below: only whole UTC hours 0–23 count — a string would be
  // spread into digits, 24 rolls into tomorrow, 19.5 publishes at 19:30.
  const ok = Array.isArray(hours)
    ? hours.filter((h): h is number => Number.isInteger(h) && h >= 0 && h <= 23)
    : [];
  return ok.length > 0 ? ok.sort((a, b) => a - b) : undefined;
}

/**
 * The Short's delay in ms for a long-form publishing on this UTC date, or undefined for the
 * standing 18 h (`SHORT_DELAY_MS`, src/youtube/youtubeUpload.ts). Negative is a teaser: the Short
 * public that many hours BEFORE the long-form (x6); further back than 6 h it would trail a match
 * nobody can watch for most of a day. Out-of-range hours (the spec is -6–48) are ignored rather
 * than trusted — this file can be hand-edited, or written by the Studio automation's own code on
 * another branch.
 */
export function shortDelayMsForDate(
  date: string,
  data: ExperimentsFile = readExperiments(),
): number | undefined {
  const hours: unknown = slotEntriesFor(date, data).find((s) => s.slot?.shortDelayHours !== undefined)?.slot
    ?.shortDelayHours;
  return typeof hours === "number" && Number.isFinite(hours) && hours >= -6 && hours <= 48
    ? hours * 3600_000
    : undefined;
}

/* --- Render arms: a tick close to tonight's render --------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const RENDER_ARM_LEAD_MS = 30 * 60_000;

// ponytail: duplicates nightly.ts's msUntilNextRun rather than importing it — nightly.ts imports
// `writeExperimentArmFile` below, and importing back would cycle the two modules. Both sides are
// five lines of date arithmetic; keep them in sync if the nightly's own rule ever changes.
function msUntilHourUtc(nowMs: number, hourUtc: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(hourUtc, 0, 0, 0);
  const ms = next.getTime() - nowMs;
  return ms > 0 ? ms : ms + DAY_MS;
}

const SETTINGS_KEYS = new Set(SETTINGS.map((f) => f.key as string));

/**
 * A tick close to tonight's render (within `RENDER_ARM_LEAD_MS` of `nightlyRenderHourUtc`; no
 * nightly scheduled means nothing to arm): applies the UTC date it is about to render on's
 * schedule entry, if any, through `saveSettings` — the only way this ever changes a setting — and
 * records `appliedOn` so a restart, or the next 15-minute tick, does not apply the same day twice.
 * A key in the entry's `render` patch that is not a real Settings field is refused with one log
 * line; the rest still applies.
 *
 * Returns whether the nightly's own timer needs re-arming (`SaveResult.rearmNightly`, true only
 * when the patch changed `nightlyRenderHourUtc` itself) — `scheduleNightly`'s `setTimeout`
 * computes its delay once at arm time and does not notice a new hour until it next fires, exactly
 * why `/api/settings`' own PUT handler calls it on the same signal (server.ts). This module cannot
 * call `scheduleNightly` itself: nightly.ts already imports `writeExperimentArmFile` below, and
 * importing back would cycle the two modules, so the caller (server.ts, which already imports
 * both) does it.
 */
export function applyScheduledRenderArm(nowMs: number = Date.now()): boolean {
  const hourUtc = config.nightlyRenderHourUtc;
  if (hourUtc === null) return false;
  if (msUntilHourUtc(nowMs, hourUtc) > RENDER_ARM_LEAD_MS) return false;
  const date = new Date(nowMs + msUntilHourUtc(nowMs, hourUtc)).toISOString().slice(0, 10);
  const data = readExperiments();
  if (data.appliedOn === date) return false;
  const entry = renderEntryFor(date, data);
  if (!entry?.render) {
    // Nothing was ever set up (no .experiments.json worth having): leave no trace of a tick that
    // did nothing. Once there is a file, recording appliedOn every night keeps this cheap either way.
    if (data.experiments.length === 0 && data.schedule.length === 0) return false;
    writeExperiments({ ...data, appliedOn: date });
    return false;
  }
  const patch: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [key, value] of Object.entries(entry.render)) {
    if (SETTINGS_KEYS.has(key)) patch[key] = value;
    else refused.push(key);
  }
  const name = `${date}'s render arm (${entry.experimentId}/${entry.arm})`;
  if (refused.length) console.error(`experiments: ${name} ignored unknown key(s) ${refused.join(", ")}`);
  let rearmNightly = false;
  if (Object.keys(patch).length) {
    try {
      const result = saveSettings(patch);
      if (result.changed.length)
        console.error(`experiments: applied ${name} — changed ${result.changed.join(", ")}`);
      rearmNightly = result.rearmNightly;
    } catch (err) {
      console.error(`experiments: ${name} failed — ${describeError(err)}`);
    }
  }
  writeExperiments({ ...data, appliedOn: date });
  return rearmNightly;
}

/* --- experiment-arm.json: which arm a render actually ran under --------------------------------- */

/** Besides the keys the day's experiment itself tests, always snapshotted — the levers most
 *  likely to be under test together or to confound one that is. */
const FIXED_SNAPSHOT_KEYS = [
  "introSec",
  "countdownTeaser",
  "explainMovesSec",
  "nightlyMaxRenders",
  "exportUpscale1440",
  "thumbnailRotatePoses",
  "copyVariety",
  "publishHourUtc",
] as const;

/**
 * Written the moment the nightly starts rendering a match, when the night's UTC date has a
 * schedule entry: a snapshot of the live settings an experiment cares about, so the match
 * directory still says which arm it rendered under even after a later settings change. A no-op
 * otherwise.
 *
 * The "night's" date is `appliedOn` — the date `applyScheduledRenderArm` already committed to,
 * ~30 minutes before the render started — when that is within a day of `nowMs`, not a fresh
 * wall-clock read: a chained render (`nightlyMaxRenders` > 1) that starts after UTC midnight has
 * passed would otherwise label itself under *tomorrow's* schedule entry while the settings
 * actually in effect are still last night's arm. Further than a day off (the nightly disabled
 * since, or never armed) falls back to wall-clock today, same as before this existed.
 */
export function writeExperimentArmFile(matchId: number, nowMs: number = Date.now()): void {
  const data = readExperiments();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const appliedRecently =
    data.appliedOn !== undefined && Math.abs(Date.parse(today) - Date.parse(data.appliedOn)) <= DAY_MS;
  const date = appliedRecently ? data.appliedOn! : today;
  const entry = renderEntryFor(date, data);
  if (!entry) return;
  const experiment = data.experiments.find((e) => e.id === entry.experimentId);
  const keys = new Set<string>(FIXED_SNAPSHOT_KEYS);
  for (const arm of experiment?.arms ?? []) for (const k of Object.keys(arm.settings ?? {})) keys.add(k);
  const live = config as unknown as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  for (const k of keys) settings[k] = live[k];

  const dir = matchDir(matchId);
  // The pipeline creates this directory itself moments later; writing first just means this file
  // is never lost to a race with it.
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "experiment-arm.json");
  const body = { date, experimentId: entry.experimentId, arm: entry.arm, settings };
  writeFileSync(`${file}.part`, JSON.stringify(body, null, 2));
  renameSync(`${file}.part`, file);
}

/* --- The Telegram report's one line and the /ask doc -------------------------------------------- */

export interface TestsSummary {
  runningCount: number;
  scheduleToday: { experimentId: string; arm: string }[];
  /** "between" experiments the evaluator produced a fresh verdict or decision for since the last
   *  report (`evaluatedAt >= sinceMs`). */
  since: { experimentId: string; verdict?: string; decision?: string }[];
}

const between = (e: Experiment): boolean => e.kind === "between";

/** Experiments the evaluator could not settle two days running (`experimentsEvaluator.ts`'s
 *  `needsHuman`) — the one thing this engine cannot fix by itself. `gatherAlerts`
 *  (src/telegram/facts.ts) surfaces these under the morning report's "⚠️ Problems", the one place
 *  the operator said he reads: without this, a dead Reporting/Analytics credential or a removed
 *  video would leave an experiment stuck `running` past its own `end` forever with nothing on
 *  screen anywhere but an `/ask` query that happens to match it. */
export function needsHumanExperiments(data: ExperimentsFile = readExperiments()): Experiment[] {
  return data.experiments.filter((e) => between(e) && e.needsHuman);
}

export function testsSummary(
  nowMs: number,
  sinceMs: number,
  data: ExperimentsFile = readExperiments(),
): TestsSummary {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const experiments = data.experiments.filter(between);
  return {
    runningCount: experiments.filter((e) => e.status === "running").length,
    scheduleToday: data.schedule
      .filter((s) => s.date === today)
      .map((s) => ({ experimentId: s.experimentId, arm: s.arm })),
    since: experiments
      .filter((e) => e.evaluatedAt && Date.parse(e.evaluatedAt) >= sinceMs && (e.verdict ?? e.decision))
      .map((e) => ({ experimentId: e.id, verdict: e.verdict, decision: e.decision })),
  };
}

/**
 * The live ledger `/ask` reads alongside `handbook/knowledge/*.md` (src/telegram/knowledge.ts) —
 * generated from `.experiments.json`, never hand-edited.
 */
export function renderExperimentsDoc(
  nowMs: number = Date.now(),
  data: ExperimentsFile = readExperiments(),
): string {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const experiments = data.experiments.filter(between);
  const lines = [
    "# Experiments — live ledger",
    "",
    "Generated from `.experiments.json`; never hand-edited. Studio's own Test & Compare runs are not listed here.",
  ];
  if (experiments.length === 0) lines.push("", "No between-video experiments on record.");
  for (const e of experiments) {
    lines.push("", `## ${e.id} — ${e.hypothesis}`);
    lines.push(
      `variable: ${e.variable} · metric: ${e.metric} · control arm: ${e.controlArm} · status: ${e.status}`,
    );
    lines.push(
      `arms: ${e.arms.map((a) => a.name).join(", ")} · window: ${e.start} to ${e.end} · videos so far: ${e.videos.length}`,
    );
    if (e.result) lines.push(`numbers: ${JSON.stringify(e.result)}`);
    if (e.verdict) lines.push(`verdict: ${e.verdict}`);
    if (e.decision) lines.push(`decision: ${e.decision}`);
    if (e.needsHuman) lines.push(`needs a human: ${e.needsHuman}`);
  }
  const ahead = data.schedule.filter((s) => s.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  lines.push("", "## Schedule ahead");
  lines.push(
    ...(ahead.length
      ? ahead.map((s) => `- ${s.date}: ${s.experimentId} / ${s.arm}`)
      : ["Nothing scheduled."]),
  );
  return lines.join("\n");
}
