/**
 * One question to Claude Haiku, through the `claude` CLI already installed in the dashboard
 * container, answered as plain text or not at all — the Telegram bot's brain since 6 Oct 2026
 * (replacing agy/Antigravity, which the Short picker keeps: src/shorts/reasoner.ts).
 *
 * The child is sandboxed from this project on purpose: `cwd` is the OS temp dir (no CLAUDE.md,
 * hooks or project settings load), `--setting-sources ""` keeps user-scope plugins and hooks out
 * too (confirmed by a real run: dropping them took a trivial prompt from ~2,100 to ~390 input
 * tokens, with auth unaffected — auth comes from `~/.claude/.credentials.json` under `HOME`, not
 * from a setting source), `--tools ""` and `--strict-mcp-config` give it nothing to call, and
 * `--disable-slash-commands` turns off skills. The env it gets is a short allow-list: never the
 * Telegram token or any other secret this process holds.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export const MODEL = "claude-haiku-4-5-20251001";
/** The real ask's budget; a ping (`facts.ts` `pingClaude`) passes its own ~30 s. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** How long a SIGTERM'd child gets before SIGKILL. */
const STOP_GRACE_MS = 5_000;
/** ponytail: a defensive ceiling, not a budget — a short plain-text answer never comes close to
 *  this; raise it if a real use ever needs more. Caps combined stdout+stderr so a misbehaving
 *  child can't grow this process's memory unbounded over the up-to-120 s window before timeout. */
const MAX_OUTPUT_BYTES = 2_000_000;

export type ClaudeReply =
  | { ok: true; text: string }
  | { ok: false; kind: "limit" | "timeout" | "missing" | "auth" | "error" | "empty"; message: string };

export type ClaudeFailure = Extract<ClaudeReply, { ok: false }>;

/** The shape of `--output-format json`'s envelope that this adapter actually reads. */
interface Envelope {
  is_error?: unknown;
  result?: unknown;
}

/** Wording the CLI has actually shown: "Claude AI usage limit reached|1760000000", "You've hit
 *  your usage limit · resets 3pm". */
export const LIMIT_RE = /usage limit|limit reached|rate.?limit|quota|out of (extra )?usage|resets? (at|in)/i;
/** "/login" is the real slash command the CLI tells a signed-out run to run. */
export const AUTH_RE =
  /not logged in|\/login|invalid api key|authentication_error|please sign in|claude setup-token|failed to authenticate|oauth access token is invalid/i;

const ENV_ALLOW = ["PATH", "HOME", "LANG", "TMPDIR"] as const;
const ENV_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** Never this process's own secrets (`TELEGRAM_BOT_TOKEN`, …) — a short allow-list only. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const k of [...ENV_ALLOW, ...ENV_AUTH]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

function buildArgs(systemPrompt: string, model: string = MODEL): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--system-prompt",
    systemPrompt,
  ];
}

export interface ClaudeOptions {
  /** The session's whole instructions — plain text, no project context. */
  systemPrompt: string;
  /** Default `MODEL` (Haiku); the title options ask Opus, which writes far better titles. */
  model?: string;
  /** Default 120 s. */
  timeoutMs?: number;
  /** The binary to run instead of `claude` (tests). */
  binary?: string;
}

/**
 * Runs `claude -p` once on `prompt` (sent over stdin, never argv — a knowledge pack can run
 * ~70 KB, comfortably past where argv would start to risk its ~128 KiB cap): its answer as plain
 * text, or why there is none. Never retries — a limit, a timeout, a missing binary or no login all
 * mean asking again right now gets the same answer.
 */
export function runClaude(prompt: string, opts: ClaudeOptions): Promise<ClaudeReply> {
  const bin = opts.binary ?? "claude";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildArgs(opts.systemPrompt, opts.model);

  return new Promise<ClaudeReply>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let done = false;
    const finish = (reply: ClaudeReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(reply);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { cwd: tmpdir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, kind: "missing", message: `${bin}: ${(err as Error).message}` });
      return;
    }

    const stop = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }, STOP_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onChunk = (into: "stdout" | "stderr") => (chunk: Buffer) => {
      if (overflowed) return;
      if (stdout.length + stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        stop();
        return;
      }
      if (into === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    proc.stdout!.on("data", onChunk("stdout"));
    proc.stderr!.on("data", onChunk("stderr"));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        err.code === "ENOENT"
          ? { ok: false, kind: "missing", message: `${bin}: not found` }
          : { ok: false, kind: "error", message: `${bin}: ${err.message}` },
      );
    });
    proc.on("close", (code) => {
      if (overflowed) {
        return finish({
          ok: false,
          kind: "error",
          message: `${bin} produced over ${Math.round(MAX_OUTPUT_BYTES / 1_000_000)} MB combined output; killed early`,
        });
      }
      if (timedOut) {
        return finish({
          ok: false,
          kind: "timeout",
          message: `${bin} timed out after ${Math.round(timeoutMs / 1000)} s`,
        });
      }
      // The CLI's own `--output-format json` envelope, when it printed one — never trust stdout
      // itself as the answer once it parses, or an empty `result` reads as a real "" answer.
      let envelope: Envelope | null = null;
      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (typeof parsed === "object" && parsed !== null) envelope = parsed as Envelope;
      } catch {
        // Bare output, not an envelope: taken as the answer itself below.
      }
      const answer = envelope
        ? typeof envelope.result === "string"
          ? envelope.result.trim()
          : ""
        : stdout.trim();
      const isError = envelope ? envelope.is_error === true : code !== 0;
      if (!isError && code === 0) {
        return finish(
          answer ? { ok: true, text: answer } : { ok: false, kind: "empty", message: "answered nothing" },
        );
      }
      const hay = `${answer}\n${stderr}`;
      const message = (answer || stderr.trim()).slice(0, 300) || `exited ${code}`;
      if (LIMIT_RE.test(hay)) return finish({ ok: false, kind: "limit", message });
      if (AUTH_RE.test(hay)) return finish({ ok: false, kind: "auth", message });
      return finish({ ok: false, kind: "error", message: `claude exited ${code}: ${message}` });
    });

    proc.stdin!.on("error", () => {}); // a process that exits before reading; `close` reports it
    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

/**
 * What the operator sees when a step can't ask Claude: exactly "usage limit reached — try again
 * later" on a limit (the operator's own wording — `/ask` and the TODAY note both repeat it
 * verbatim), a one-line fix for a missing binary or no login, the adapter's own message otherwise.
 */
export function describeFailure(reply: ClaudeFailure): string {
  switch (reply.kind) {
    case "limit":
      return "usage limit reached — try again later";
    case "missing":
      return "binary missing in the container";
    case "auth":
      return "run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in /app/.env";
    case "timeout":
    case "error":
      return reply.message;
    case "empty":
      return "answered nothing";
  }
}
