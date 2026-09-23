import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";

/**
 * One question to an external LLM CLI, answered as one JSON object or not at all.
 *
 * The configured command (`reasonerCommand`, e.g. Antigravity's `agy -p "{prompt}"
 * --output-format json`) is a black box that takes a prompt and prints text. Everything about
 * what it prints is handled defensively: the CLI's own envelope is unwrapped when there is one,
 * the first balanced `{...}` is taken from whatever remains, and every failure — not configured,
 * not installed, not signed in, non-zero exit, timeout, no JSON — is a reason (`runReasoner`) or
 * a `null` and one stderr line (`askReasoner`). The caller always has a heuristic answer of its
 * own, so nothing here may throw or stall a render; only an abort the caller asked for rejects.
 */

// The command inherits this process's environment, and an API key is how `agy` authenticates
// where no browser and no keyring exist — which is every container the dashboard runs in. Loaded
// here as well as in twitch.ts because otherwise the key reaches the child only as a side effect
// of the Twitch module having been imported first, which is true today and one refactor from
// being false. `loadEnvFile` does not overwrite variables already set, so a real env still wins.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // A malformed .env means "no key": the command will fail its own way and the caller falls
    // back to the heuristic, which is what happens when it is not configured at all.
  }
}

const PREAMBLE =
  "Answer with a single JSON object and nothing else: no prose before or after it, no code fence.";

/** Exactly what the command is sent, so the CLI can print it for the operator to try by hand. */
export function reasonerPrompt(task: string, input: unknown): string {
  return `${PREAMBLE}\n\n${task.trim()}\n\nInput:\n${JSON.stringify(input, null, 2)}\n`;
}

export const reasonerConfigured = (): boolean => (config.reasonerCommand?.length ?? 0) > 0;

/**
 * The first balanced `{...}` in the text, or null. String-aware so a brace inside a quoted
 * value ("why": "the {} moment") does not unbalance the scan.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return typeof parsed === "object" && parsed !== null ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The answer inside what the CLI printed. Antigravity's `--output-format json` is one envelope —
 * `{ status, response, error, … }`, plus `structured_output` when `--json-schema` was given — so
 * the answer is the structured output when there is one, else the first object in `response`.
 * Output that is not an envelope is taken as the answer itself, prose around it and all.
 */
function answerIn(stdout: string): { answer: object } | { error: string } {
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === "object" && parsed !== null) envelope = parsed as Record<string, unknown>;
  } catch {
    // Not an envelope: the CLI printed the answer bare.
  }
  if (envelope && ("response" in envelope || "structured_output" in envelope)) {
    const { structured_output: structured, response, status, error, denied_actions: denied } = envelope;
    if (typeof structured === "object" && structured !== null) return { answer: structured };
    const text = typeof structured === "string" ? structured : typeof response === "string" ? response : "";
    const inner = firstJsonObject(text);
    if (inner) return { answer: inner as object };
    // Headless agy denies a tool it would have to ask about ("command" when the model tries a
    // shell) and then answers "" with status SUCCESS: the denial is the reason.
    const actions = Array.isArray(denied)
      ? denied.map((d) => String((d as { action?: unknown })?.action ?? "?")).join(", ")
      : "";
    if (actions) return { error: `answered nothing: headless mode denied the "${actions}" tool` };
    return {
      error:
        status === undefined || status === "SUCCESS"
          ? "answered with no JSON object"
          : `answered ${String(status)}${error ? `: ${String(error)}` : ""}`,
    };
  }
  const bare = firstJsonObject(stdout);
  return bare ? { answer: bare as object } : { error: "printed no JSON object" };
}

export interface ReasonerOptions {
  /** Default 60 s; the command is stopped on expiry (SIGTERM, then SIGKILL 5 s later). */
  timeoutMs?: number;
  /** The command to run instead of the configured one (tests). */
  command?: readonly string[] | null;
  /**
   * Fills an argument that is exactly `{schema}` with this JSON Schema, inline — agy's
   * `--json-schema` takes a string and holds the answer to it. Without a schema the argument goes,
   * and so does the flag before it, so one `reasonerCommand` serves every caller.
   */
  schema?: object;
  /**
   * Fills `{dir}`: a directory the CLI may read (agy's `--add-dir`). Several repeat the flag
   * before it, once per directory. Dropped with its flag when absent or empty.
   */
  dir?: string | readonly string[];
  /** Stops the command and rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * `retryable` is set when the command ran to its end and gave no usable answer — nothing, a tool
 * denied, no JSON, a non-zero exit — which a second ask can fix. Not signed in, a timeout, a
 * missing binary and no configuration cannot be fixed by asking again.
 */
export type ReasonerReply =
  { ok: true; answer: object; raw: string } | { ok: false; error: string; raw: string; retryable?: boolean };

/** What the operator is told when agy is installed but has no login to use. */
export const NOT_SIGNED_IN =
  "Antigravity is not signed in — run: HOME=/app/.tools/agy-home /app/.tools/bin/agy";

/**
 * How agy says so. Unauthenticated, print mode writes "Authentication required. Please visit the
 * URL to log in" to stderr and waits a minute for a code nobody will paste, then prints an ERROR
 * envelope, "authentication failed or timed out"; `agy models` says "Please sign in". Seen on
 * agy 1.2.9 in the Claude container, 23 Sept 2026. The command is stopped the moment it shows.
 */
const SIGN_IN_WANTED =
  /Authentication required|Please sign in|not logged into Antigravity|authentication failed/i;

/** The argv with its placeholders filled; a placeholder with no value is dropped with its flag. */
export function reasonerArgs(
  rest: readonly string[],
  prompt: string,
  opts: Pick<ReasonerOptions, "schema" | "dir"> = {},
): string[] {
  const out: string[] = [];
  const dirs = typeof opts.dir === "string" ? [opts.dir] : [...(opts.dir ?? [])];
  for (const a of rest) {
    if (a === "{dir}" && dirs.length > 1) {
      const flag = out[out.length - 1]?.startsWith("-") ? out[out.length - 1]! : null;
      dirs.forEach((d, i) => (i > 0 && flag ? out.push(flag, d) : out.push(d)));
      continue;
    }
    const value =
      a === "{prompt}"
        ? prompt
        : a === "{schema}"
          ? opts.schema
            ? JSON.stringify(opts.schema)
            : null
          : a === "{dir}"
            ? (dirs[0] ?? null)
            : a;
    if (value !== null) out.push(value);
    else if (out[out.length - 1]?.startsWith("-")) out.pop();
  }
  return out;
}

/** How long a stopped command gets to shut down (agy takes its language server with it) before SIGKILL. */
const STOP_GRACE_MS = 5_000;

/**
 * Runs the configured command once on `prompt`: its JSON answer, or why there is none. `raw` is
 * everything it printed, for the CLI and the logs. Resolves on every failure; rejects only with
 * the abort reason when `signal` fires.
 */
export async function runReasoner(prompt: string, opts: ReasonerOptions = {}): Promise<ReasonerReply> {
  const command = opts.command === undefined ? config.reasonerCommand : opts.command;
  const [bin, ...rest] = command ?? [];
  if (!bin) return { ok: false, error: "not configured (reasonerCommand)", raw: "" };
  opts.signal?.throwIfAborted();
  const args = reasonerArgs(rest, prompt, opts);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<ReasonerReply>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const raw = () =>
      [stdout.trim(), stderr.trim() && `[stderr] ${stderr.trim()}`].filter(Boolean).join("\n");
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${(err as Error).message}`, raw: "" });
      return;
    }
    // A missing binary raises `error` and then `close`; one verdict is enough.
    let done = false;
    const finish = (reply: ReasonerReply | { abort: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if ("abort" in reply) reject(reply.abort);
      else resolve(reply);
    };
    // Why the command was stopped, once it was.
    let stopped: string | null = null;
    const stop = (why: string) => {
      if (stopped !== null) return;
      stopped = why;
      // SIGTERM first: agy shuts its language server down on it, where SIGKILL would orphan it.
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }, STOP_GRACE_MS).unref();
    };
    const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
    const timer = setTimeout(() => stop(`${bin} timed out after ${limit}`), timeoutMs);
    const onAbort = () => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (SIGN_IN_WANTED.test(stderr)) stop(NOT_SIGNED_IN);
    });
    proc.on("error", (err) => finish({ ok: false, error: `${bin}: ${err.message}`, raw: raw() }));
    proc.on("close", (code) => {
      if (stopped === "aborted") return finish({ abort: opts.signal?.reason ?? new Error("aborted") });
      if (stopped) return finish({ ok: false, error: stopped, raw: raw() });
      const found = answerIn(stdout);
      if (code === 0 && "answer" in found) return finish({ ok: true, answer: found.answer, raw: raw() });
      if (SIGN_IN_WANTED.test(stdout)) return finish({ ok: false, error: NOT_SIGNED_IN, raw: raw() });
      const why = "error" in found && stdout.trim() ? found.error : (stderr.trim().split("\n").pop() ?? "");
      finish({
        ok: false,
        error: code === 0 ? `${bin} ${why}` : `${bin} exited ${code}: ${why}`,
        raw: raw(),
        retryable: true,
      });
    });
    // The prompt goes on stdin unless the argv carries it, in which case stdin is closed at once
    // so a CLI that reads it to EOF does not hang.
    proc.stdin.on("error", () => {}); // EPIPE from a command that exits before reading; close reports it
    if (!rest.includes("{prompt}")) proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/** `runReasoner` on the task and its input: the answer, or null and one stderr line saying why. */
export async function askReasoner(
  task: string,
  input: unknown,
  opts: ReasonerOptions = {},
): Promise<unknown> {
  const reply = await runReasoner(reasonerPrompt(task, input), opts);
  if (reply.ok) return reply.answer;
  console.error(`reasoner: ${reply.error}`);
  return null;
}
