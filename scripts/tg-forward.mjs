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

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Bold, links, code and italics inside one line; code spans are kept out of everything else. */
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(codes[Number(n)])}</code>`);
}

/** A table cell for a monospace block: the text, without the Markdown around it. */
const plainCell = (c) => c.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "").trim();

/**
 * Claude writes Markdown; Telegram's HTML mode renders the same things, so the forward reads as it
 * did here instead of showing raw asterisks (the operator, 29 Sept 2026: "incorporate markdown ...
 * for better formatting"). Headings and **bold** → bold, `code` and fences → code, [t](u) → links,
 * "- " → "•", and a | table | → an aligned monospace block (Telegram has no tables).
 */
export function mdToTelegramHtml(md) {
  const lines = md.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // the |---|---| rule
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map(plainCell));
      }
      i--;
      const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
      const text = rows.map((r) => r.map((c, k) => c.padEnd(widths[k] ?? 0)).join("  ").trimEnd()).join("\n");
      out.push(`<pre>${escapeHtml(text)}</pre>`);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    out.push(bullet ? `${bullet[1]}• ${inline(bullet[2])}` : inline(line));
  }
  return out.join("\n");
}

/**
 * Markdown in pieces of at most `max` characters, cut between paragraphs and never inside a code
 * fence, so each piece converts to HTML on its own; a paragraph longer than `max` is cut hard.
 */
export function chunkMarkdown(md, max = 3500) {
  const paras = [];
  let cur = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && line.trim() === "" && cur.length) {
      paras.push(cur.join("\n"));
      cur = [];
    } else if (fence || line.trim() !== "") cur.push(line);
  }
  if (cur.length) paras.push(cur.join("\n"));
  const chunks = [];
  let acc = "";
  for (const p of paras.flatMap((p) => splitAt(p, max))) {
    if (acc && acc.length + 2 + p.length > max) {
      chunks.push(acc);
      acc = "";
    }
    acc = acc ? `${acc}\n\n${p}` : p;
  }
  if (acc) chunks.push(acc);
  return chunks;
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

/** `--dry-run` / `TG_FORWARD_DRY_RUN=1`: print what would be sent instead of calling the API — the
 *  only way to exercise this script's real send path without either a live token or a copy edited
 *  outside the repo (bot.ts's `sendMessage` and tgCli.ts already offer the same seam). */
const DRY_RUN = process.argv.includes("--dry-run") || process.env.TG_FORWARD_DRY_RUN === "1";

async function sendMessage(token, chatId, text, html = false) {
  if (DRY_RUN) {
    console.log(text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(html ? { parse_mode: "HTML" } : {}),
    }),
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

  const chunks = chunkMarkdown(text);
  for (const [i, chunk] of chunks.entries()) {
    const head = i === 0 ? `<b>Claude</b> · <i>${warsawTimeLabel()}</i>\n\n` : "";
    // Formatting Telegram refuses to parse must never cost the report: the same piece goes as plain text.
    await sendMessage(token, chatId, `${head}${mdToTelegramHtml(chunk)}`, true).catch(() =>
      sendMessage(token, chatId, `${i === 0 ? `Claude · ${warsawTimeLabel()}\n\n` : ""}${chunk}`),
    );
  }
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
