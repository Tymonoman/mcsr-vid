#!/usr/bin/env node
/**
 * Claude Code's Stop hook (`.claude/settings.json`): forwards this turn's last assistant message
 * to the operator's Telegram chat "for safekeeping" when it is a substantial report (>= 300
 * characters) — deliberately not every short reply.
 *
 * Plain Node, no `tsx`: a Stop hook runs after every turn, so it has to be fast, and it must
 * never block or break a session — 10 s total timeout, always exits 0, never prints the token.
 * Reads `/app/.env` itself (this is not run through the app's own module loader) and stays
 * silent whenever the keys are missing, exactly as no forwarding configured looks.
 *
 * Stop hook stdin (Claude Code's documented shape): `{ session_id, transcript_path,
 * hook_event_name, stop_hook_active, cwd? }`. Only `transcript_path` is load-bearing here; every
 * other field is read defensively and never required.
 */
import { readFileSync, existsSync } from "node:fs";

const ENV_PATH = "/app/.env";
const MIN_CHARS = 300;
const MESSAGE_MAX_CHARS = 4096;
const TOTAL_TIMEOUT_MS = 10_000;

/** A tiny `.env` reader — this script cannot rely on `process.loadEnvFile` reading a specific
 *  path relative to some other cwd, since a Stop hook's cwd is the session's working directory. */
export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * The text of the LAST assistant message in a transcript JSONL: every `content` block of type
 * `"text"` on the last line whose `type` is `"assistant"`, joined. Null when there is none —
 * a transcript with only tool calls and thinking, or one this script cannot parse a line of.
 */
export function lastAssistantText(jsonlText) {
  let lastBlocks = null;
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // a truncated last line (the file being written as this hook runs) is skipped, not fatal
    }
    if (obj?.type !== "assistant") continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
    if (texts.length) lastBlocks = texts;
  }
  return lastBlocks ? lastBlocks.join("\n\n").trim() : null;
}

/** "28 Sep 2026, 07:04" in Europe/Warsaw — this file's own tiny formatter (no import of schedule.ts: no tsx here). */
export function warsawTimeLabel(nowMs = Date.now()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
}

/** Split at `max` characters, on the last newline before it when there is a reasonable one. */
export function splitAt(text, max = MESSAGE_MAX_CHARS) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const soft = rest.lastIndexOf("\n", max);
    const cut = soft > max / 2 ? soft : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

async function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function sendMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage -> ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function main() {
  const env = readEnvFile(ENV_PATH);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // not configured — the same silence as nothing to forward

  const raw = await readStdin(3_000);
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    return;
  }
  const transcriptPath = hook?.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  const text = lastAssistantText(readFileSync(transcriptPath, "utf8"));
  if (!text || text.length < MIN_CHARS) return;

  const header = `Claude · ${warsawTimeLabel()}\n\n`;
  const parts = splitAt(`${header}${text}`);
  for (const part of parts) await sendMessage(token, chatId, part);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const timeout = setTimeout(() => process.exit(0), TOTAL_TIMEOUT_MS).unref();
  main()
    .catch(() => {
      // Never breaks a session: any failure here (network, a malformed transcript) is silent.
    })
    .finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
}
