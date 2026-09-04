/**
 * On-demand review of a published upload.
 *
 * `/watch` is a Claude Code *plugin*, not a binary: it extracts frames and a transcript and then
 * needs a model to actually look at them. So this spawns a headless Claude session and asks it
 * to run `/watch` on the video, rather than calling anything directly.
 *
 * Never automatic. It costs tokens and minutes per run, and an audit nobody asked for is an
 * audit nobody reads — the dashboard requires an explicit press, and says what it will spend.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { describeError } from "./errorText.js";

/** Frame extraction and transcription on a 10-minute video is slow; this is a ceiling, not a target. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** Headless Claude. Overridable so the audit can be pointed at any tool that reads a prompt. */
const DEFAULT_COMMAND = "claude -p";

export interface AuditInput {
  matchId: number;
  videoId: string;
  title: string;
  description: string;
  /** Left/right nicknames, so the reviewer knows who it is watching. */
  players: [string, string];
  /** Live numbers, when the API was reachable — an audit is more useful knowing how it did. */
  stats?: { views: number; likes: number; comments: number } | null;
  /** Thumbnail impressions and click-through, when the Reporting job has a row for this video. */
  reach?: { impressions: number; ctr: number } | null;
}

export interface AuditState {
  matchId: number;
  running: boolean;
  /** Everything the command has printed so far, so the browser can stream it into a <pre>. */
  output: string;
  error: string | null;
  /** Where the finished markdown landed, once it has. */
  reportPath: string | null;
}

const audits = new Map<number, AuditState>();

export const auditPath = (matchId: number): string =>
  path.join(config.mediaDir, String(matchId), `match-${matchId}.audit.md`);

export function auditState(matchId: number): AuditState {
  return (
    audits.get(matchId) ?? {
      matchId,
      running: false,
      output: "",
      error: null,
      reportPath: existsSync(auditPath(matchId)) ? auditPath(matchId) : null,
    }
  );
}

export async function readAudit(matchId: number): Promise<string | null> {
  const file = auditPath(matchId);
  return existsSync(file) ? readFile(file, "utf8") : null;
}

/**
 * The whole brief, in one prompt.
 *
 * Deliberately asks for specific, timestamped, actionable notes: an unconstrained "review this"
 * returns a summary of the match, which is the one thing the operator already knows. The numbers
 * are included so the reviewer can tie a weak hook to a weak click-through rather than guess.
 */
export function buildAuditPrompt(input: AuditInput): string {
  const url = `https://www.youtube.com/watch?v=${input.videoId}`;
  const numbers = [
    input.stats ? `views ${input.stats.views}, likes ${input.stats.likes}, comments ${input.stats.comments}` : null,
    input.reach
      ? `thumbnail impressions ${input.reach.impressions}, click-through ${(input.reach.ctr * 100).toFixed(2)}%`
      : null,
  ].filter(Boolean);

  return [
    `Run /watch ${url} — I am auditing my own upload for editing mistakes.`,
    "",
    `This is MCSR Replayoffs: a synced dual-POV Minecraft speedrun race between ${input.players[0]} and ${input.players[1]},`,
    "with a live split-comparison overlay. No commentary track by design.",
    "",
    `Title: ${input.title}`,
    numbers.length ? `Performance so far: ${numbers.join("; ")}` : "No performance data yet.",
    "",
    "After watching, write a report with these sections and nothing else:",
    "",
    "1. **Mistakes** — concrete defects with timestamps: overlay covering gameplay, desynced POVs,",
    "   wrong or stale stats on screen, audio problems, dead air, an abrupt start or end.",
    "   If you find none, say so plainly rather than inventing something.",
    // Only cite the CTR when there is one: pointing a reviewer at "the click-through rate above"
    // when the line above says "no performance data" invites it to invent a number.
    input.reach
      ? "2. **First 10 seconds** — does the opening earn the click, given the click-through rate above?"
      : "2. **First 10 seconds** — does the opening earn the click?",
    "3. **Pacing** — where does attention most likely drop, and what would you cut?",
    "4. **Thumbnail and title** — do they match what the video actually delivers?",
    "5. **Next upload** — at most three changes, ordered by how much they would matter.",
    "",
    "Be specific and critical. Vague praise is worse than nothing here.",
  ].join("\n");
}

/**
 * Starts an audit, or returns the one already running for this match.
 *
 * Returns as soon as the process is spawned; the caller polls `auditState`. A run outlives any
 * request timeout, and there is nothing to stream back to a browser that has since closed.
 */
export function startAudit(input: AuditInput): AuditState {
  const existing = audits.get(input.matchId);
  if (existing?.running) return existing;

  const state: AuditState = {
    matchId: input.matchId,
    running: true,
    output: "",
    error: null,
    reportPath: null,
  };
  audits.set(input.matchId, state);

  const command = process.env.AUDIT_CMD ?? DEFAULT_COMMAND;
  const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const proc = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);

  proc.stdout.on("data", (d) => (state.output += String(d)));
  // stderr is where a missing plugin or an unauthenticated CLI complains, and that is exactly
  // what the operator needs to see — so it is kept rather than discarded.
  proc.stderr.on("data", (d) => (state.output += String(d)));

  proc.on("error", (err) => {
    clearTimeout(timer);
    state.error = `${describeError(err)} (AUDIT_CMD: ${command})`;
    state.running = false;
  });

  // The command may not read the prompt; without this, its exit closes the pipe under our write
  // and the unhandled EPIPE takes the dashboard down.
  proc.stdin.on("error", () => {});

  proc.on("close", (code, signal) => {
    clearTimeout(timer);
    state.running = false;
    if (signal === "SIGKILL") {
      state.error = `Audit timed out after ${Math.round(timeoutMs / 60000)} minutes`;
      return;
    }
    if (code !== 0) {
      state.error = `AUDIT_CMD exited with code ${code}. Output above is everything it printed.`;
      return;
    }
    void writeFile(auditPath(input.matchId), state.output, "utf8")
      .then(() => (state.reportPath = auditPath(input.matchId)))
      .catch((err: unknown) => (state.error = describeError(err)));
  });

  proc.stdin.end(buildAuditPrompt(input));
  return state;
}
