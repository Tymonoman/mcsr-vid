/**
 * The Short's per-match log and the box's live activity (the contract is shortPlan.ts).
 *
 * Every stage of the pick, the render and the uploads appends a `ShortLogLine` to
 * `short-<id>.log.jsonl` in the match's directory — the panel's Details fold and the only record a
 * morning has of what the night did. The same call moves the step's live line: a step running
 * in this process (`startActivity` … `endActivity`) shows its newest info line as "what it is
 * doing now", which is what the panel's status line and the strip's Activity read.
 *
 * One line is one `appendFileSync` of one JSON object and a newline, so two processes (the
 * dashboard and a `npm run pick` by hand) never interleave inside a line. The file is trimmed to
 * its last ~500 lines once it passes TRIM_AT_BYTES.
 *
 * Nothing here may fail a step: a log that cannot be written is one stderr line.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchDir } from "../config.js";
import type { ShortActivity, ShortLogLine } from "./shortPlan.js";

export const shortLogFile = (dir: string, matchId: number): string =>
  path.join(dir, `short-${matchId}.log.jsonl`);

const KEEP_LINES = 500;
/** Trimmed past this, down to KEEP_LINES and half of it — so a trim buys the next half. */
const TRIM_AT_BYTES = 1024 * 1024;
/** A model's raw answer or a stderr tail: its head and its tail, enough to act on. */
const DETAIL_CHARS = 4000;

export interface LogExtra {
  level?: ShortLogLine["level"];
  detail?: string;
  percent?: number;
}

const clip = (text: string): string =>
  text.length <= DETAIL_CHARS
    ? text
    : `${text.slice(0, DETAIL_CHARS / 2)}\n…\n${text.slice(-DETAIL_CHARS / 2)}`;

function trim(file: string): void {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < KEEP_LINES; i--) {
    bytes += lines[i]!.length + 1;
    if (bytes > TRIM_AT_BYTES / 2) break;
    kept.unshift(lines[i]!);
  }
  // ponytail: a line another process appends between the read and the rename is lost; one line,
  // once per megabyte of log.
  writeFileSync(`${file}.part`, kept.map((l) => `${l}\n`).join(""));
  renameSync(`${file}.part`, file);
}

/* --- Activity: the step running now, per match and step ---------------------------------------- */

type ActivityStep = ShortActivity["step"];
interface Running extends ShortActivity {
  matchId: number;
  started: number;
  /** The last quarter of `percent` written to the log, so progress is four lines, not four hundred. */
  quarter: number;
}
const running = new Map<string, Running>();
const key = (matchId: number, step: ActivityStep) => `${step}:${matchId}`;

const publicOf = ({ step, line, since, percent }: Running): ShortActivity => ({
  step,
  line,
  since,
  ...(percent === undefined ? {} : { percent }),
});

/**
 * Append one line to the match's log. When the step is running in this process, an info line is
 * also its live line (a warning is an event, not what it is doing). No directory, no log: a match
 * never started is not given one.
 */
export function shortLog(
  matchId: number,
  step: ShortLogLine["step"],
  text: string,
  extra: LogExtra = {},
): void {
  const line: ShortLogLine = {
    at: new Date().toISOString(),
    step,
    level: extra.level ?? "info",
    text,
    ...(extra.detail?.trim() ? { detail: clip(extra.detail.trim()) } : {}),
  };
  const live = step === "chain" ? undefined : running.get(key(matchId, step));
  if (live && line.level === "info") {
    live.line = text;
    live.since = line.at;
    live.percent = extra.percent;
  }
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return;
  const file = shortLogFile(dir, matchId);
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    if (statSync(file).size > TRIM_AT_BYTES) trim(file);
  } catch (err) {
    console.error(`short log #${matchId}: ${(err as Error).message}`);
  }
}

/** The last `n` lines, oldest first. Unreadable lines are skipped. */
export function readShortLog(matchId: number, n = 60): ShortLogLine[] {
  let text: string;
  try {
    text = readFileSync(shortLogFile(matchDir(matchId), matchId), "utf8");
  } catch {
    return [];
  }
  const out: ShortLogLine[] = [];
  for (const raw of text.split("\n").filter(Boolean).slice(-n)) {
    try {
      out.push(JSON.parse(raw) as ShortLogLine);
    } catch {
      // A torn line from a crash mid-write: the rest of the log still reads.
    }
  }
  return out;
}

/** A step begins: logged, and its line is the match's live one until `endActivity`. */
export function startActivity(matchId: number, step: ActivityStep, text: string, extra: LogExtra = {}): void {
  running.set(key(matchId, step), {
    matchId,
    step,
    line: text,
    since: new Date().toISOString(),
    started: Date.now(),
    quarter: 0,
  });
  shortLog(matchId, step, text, extra);
}

/**
 * Progress on the running step: the live percent always, a log line at each quarter. A new
 * `text` replaces the live line (a new phase, e.g. the board drawn, now encoding).
 */
export function activityProgress(matchId: number, step: ActivityStep, percent: number, text?: string): void {
  const live = running.get(key(matchId, step));
  if (!live) return;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  if (text && text !== live.line) {
    live.line = text;
    live.since = new Date().toISOString();
  }
  live.percent = pct;
  const quarter = Math.floor(pct / 25);
  if (quarter > live.quarter && pct < 100) {
    live.quarter = quarter;
    // Straight to the file: the live line keeps its own words and time.
    const dir = matchDir(matchId);
    if (existsSync(dir))
      try {
        appendFileSync(
          shortLogFile(dir, matchId),
          `${JSON.stringify({ at: new Date().toISOString(), step, level: "info", text: `${live.line} · ${pct}%` } satisfies ShortLogLine)}\n`,
        );
      } catch {
        // As shortLog: never the step's failure.
      }
  }
}

export function endActivity(matchId: number, step: ActivityStep): void {
  running.delete(key(matchId, step));
}

/** This one step's live line, if it is running. */
export function stepActivity(matchId: number, step: ActivityStep): ShortActivity | undefined {
  const live = running.get(key(matchId, step));
  return live ? publicOf(live) : undefined;
}

/** The step running now for this match — the newest started, when two overlap. */
export function activityOf(matchId: number): ShortActivity | undefined {
  const mine = [...running.values()].filter((r) => r.matchId === matchId);
  const newest = mine.sort((a, b) => b.started - a.started)[0];
  return newest ? publicOf(newest) : undefined;
}

/** Everything running on the box, oldest first: the strip's Activity line. */
export const runningActivities = (): Array<{ matchId: number } & ShortActivity> =>
  [...running.values()]
    .sort((a, b) => a.started - b.started)
    .map((r) => ({ matchId: r.matchId, ...publicOf(r) }));

/* --- Failures that are the box's, not the step's ------------------------------------------------ */

/**
 * The failures any child process on the lab can hit, whatever it was doing — the disk full, the
 * container's memory cap, a tool not installed — as "what happened — what to do", or null when
 * the text is none of them. `what` names the thing that failed ("the proxy", "the render").
 */
export function boxFailure(
  what: string,
  text: string,
  exit: { code?: number | null; signal?: string | null } = {},
): string | null {
  if (/ENOSPC|No space left on device/i.test(text))
    return `${what} failed: the disk is full (no space left on the media drive) — free space (the oldest published matches), then try again`;
  if (
    exit.code === 137 ||
    exit.signal === "SIGKILL" ||
    /\bout of memory\b|\bOOM\b|\bKilled\b|\bSIGKILL\b|\b(?:exit(?:ed)?|code)\D{0,12}137\b/i.test(text)
  )
    return `${what} was killed — out of memory (the container's 4 GB cap, exit 137); try again when no encode or render is running`;
  const missing =
    /spawn (\S+) ENOENT/.exec(text) ??
    /nice: '([^']+)': No such file or directory/.exec(text) ??
    /(?:^|\n)(?:\S+: )?(?:\d+: )?(\S+): (?:command )?not found/.exec(text);
  if (missing) {
    const tool = path.basename(missing[1]!);
    return `${what} failed: ${tool} is not installed in this container — install it (or fix the path), then try again`;
  }
  return null;
}
