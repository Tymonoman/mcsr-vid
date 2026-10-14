/**
 * The Telegram Bot API, over `fetch`, with no dependency — the same call `apiCall` makes in
 * src/youtube/youtube.ts, for the same reason (one form POST and a JSON body do not need an SDK).
 * Outbound only: long polling (`getUpdates`), `sendMessage`, `sendDocument`, `setMyCommands`. No
 * webhook, no port.
 *
 * Secrets load the way src/shorts/reasoner.ts and src/api/twitch.ts do: `.env` if it is there,
 * never overwriting a real env var. Never logged, never put in an error message — `call`'s errors
 * carry Telegram's own `description`, not the request URL the token lives in.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // A malformed .env means "not configured": the bot does nothing, same as no file at all.
  }
}

const API = "https://api.telegram.org";

export const token = (): string | undefined => process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
export const chatId = (): string | undefined => process.env.TELEGRAM_CHAT_ID?.trim() || undefined;

/** A token is present — enough to answer `/start` with the chat id and send test messages. */
export const isConfigured = (): boolean => !!token();
/** Both secrets are present — the bot can send the operator's chat unprompted (the morning report). */
export const hasChat = (): boolean => !!token() && !!chatId();

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

async function call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  const tok = token();
  if (!tok) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`${API}/bot${tok}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: T;
    description?: string;
  } | null;
  if (!json?.ok) {
    throw new TelegramApiError(`Telegram ${method}: ${json?.description ?? res.status}`, res.status);
  }
  return json.result as T;
}

export const MESSAGE_MAX_CHARS = 4096;

/**
 * `text` in pieces of at most `max` characters, breaking on the last newline before the limit
 * when there is a reasonable one (past its first half), else cutting hard. Never used by the
 * morning report itself (that one message must fit whole — `report.ts` caps it), but every
 * `sendMessage` call goes through this so a long `/health` or `/comments` answer still arrives.
 */
export function splitMessage(text: string, max = MESSAGE_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const softCut = rest.lastIndexOf("\n", max);
    const cut = softCut > max / 2 ? softCut : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** `&`, `<`, `>` — the three characters Telegram's HTML parse mode requires escaped in text. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SendOptions {
  html?: boolean;
  /** True shows a link preview; the reports never want one. */
  preview?: boolean;
  /** Test/CLI seam: print instead of calling the API. */
  dryRun?: boolean;
}

/** Sends `text` to the operator's chat, split at `MESSAGE_MAX_CHARS`. Throws if not configured. */
export async function sendMessage(text: string, opts: SendOptions = {}): Promise<void> {
  if (opts.dryRun) {
    console.log(text);
    return;
  }
  const chat = chatId();
  if (!chat) throw new Error("TELEGRAM_CHAT_ID is not set");
  for (const part of splitMessage(text)) {
    await call("sendMessage", {
      chat_id: chat,
      text: part,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      disable_web_page_preview: opts.preview !== true,
    });
  }
}

/** Sends `text` to one chat id — used for the pairing reply to `/start` before `TELEGRAM_CHAT_ID` is set. */
export async function sendMessageTo(chat: string | number, text: string): Promise<void> {
  await call("sendMessage", { chat_id: chat, text });
}

/** A local file as a document, e.g. `npm run tg -- send --file <path>`. Caption capped at 1024 chars. */
export async function sendDocument(filePath: string, caption?: string): Promise<void> {
  const tok = token();
  const chat = chatId();
  if (!tok || !chat) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
  const form = new FormData();
  form.set("chat_id", chat);
  if (caption) form.set("caption", caption.slice(0, 1024));
  const buf = await readFile(filePath);
  form.set("document", new Blob([new Uint8Array(buf)]), path.basename(filePath));
  const res = await fetch(`${API}/bot${tok}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as { ok: boolean; description?: string } | null;
  if (!json?.ok)
    throw new TelegramApiError(`Telegram sendDocument: ${json?.description ?? res.status}`, res.status);
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  date: number;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** Long-poll for updates since `offset`. `timeoutSec` should stay under the HTTP client's own timeout. */
export function getUpdates(offset: number | undefined, timeoutSec = 50): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ["message"] },
    (timeoutSec + 10) * 1000,
  );
}

export interface BotCommand {
  command: string;
  description: string;
}

export async function setMyCommands(commands: readonly BotCommand[]): Promise<void> {
  await call("setMyCommands", { commands });
}
