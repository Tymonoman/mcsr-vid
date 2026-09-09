import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * One question to an external LLM CLI, answered as one JSON object or not at all.
 *
 * The configured command (`reasonerCommand`, e.g. Antigravity's `agy -p "{prompt}"
 * --output-format json`) is a black box that takes a prompt and prints text. Everything about
 * what it prints is handled defensively: the CLI's own envelope is unwrapped when there is one,
 * the first balanced `{...}` is taken from whatever remains, and every failure — not configured,
 * not installed, non-zero exit, timeout, no JSON — is a `null` and one stderr line. The caller
 * always has a heuristic answer of its own, so nothing here may throw or stall a render.
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

/** The CLI's envelope, `{ response: "…" }`, unwrapped; anything else is taken as the answer itself. */
function unwrap(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && "response" in parsed) {
      const response = (parsed as { response: unknown }).response;
      if (typeof response === "string") return response;
    }
  } catch {
    // Not an envelope: the CLI printed the answer bare.
  }
  return stdout;
}

export interface ReasonerOptions {
  /** Default 60 s; the command is killed on expiry. */
  timeoutMs?: number;
  /** The command to run instead of the configured one (tests). */
  command?: readonly string[] | null;
}

export async function askReasoner(
  task: string,
  input: unknown,
  opts: ReasonerOptions = {},
): Promise<unknown> {
  const command = opts.command === undefined ? config.reasonerCommand : opts.command;
  const fail = (reason: string): null => {
    console.error(`reasoner: ${reason}`);
    return null;
  };
  const [bin, ...rest] = command ?? [];
  if (!bin) return fail("not configured (reasonerCommand)");

  const prompt = reasonerPrompt(task, input);
  const viaArgv = rest.includes("{prompt}");
  const args = rest.map((a) => (a === "{prompt}" ? prompt : a));

  return new Promise<unknown>((resolve) => {
    // A missing binary raises `error` and then `close`; one verdict is enough.
    let settled = false;
    const settle = (value: unknown) => {
      if (!settled) resolve(value);
      settled = true;
    };
    let proc;
    try {
      proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: opts.timeoutMs ?? 60_000,
        // Kills the CLI only, not anything it forked; tini as PID 1 reaps what that orphans.
        killSignal: "SIGKILL",
      });
    } catch (err) {
      settle(fail(`spawn failed: ${(err as Error).message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", (err) => settle(fail(`${bin}: ${err.message}`)));
    proc.on("close", (code, signal) => {
      if (settled) return;
      if (signal) return settle(fail(`${bin} killed by ${signal} (timeout ${opts.timeoutMs ?? 60_000} ms)`));
      if (code !== 0) return settle(fail(`${bin} exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
      const answer = firstJsonObject(unwrap(stdout));
      settle(answer ?? fail(`${bin} printed no JSON object`));
    });
    // The prompt goes on stdin unless the argv carries it, in which case stdin is closed at once
    // so a CLI that reads it to EOF does not hang.
    proc.stdin.on("error", () => {}); // EPIPE from a command that exits before reading; close reports it
    if (!viaArgv) proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
