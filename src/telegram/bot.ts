/**
 * The Telegram Bot API, over `fetch`, with no dependency — the same call `apiCall` makes in
 * src/youtube/youtube.ts, for the same reason (one form POST and a JSON body do not need an SDK).
 * Long polling (`getUpdates`, now also carrying `callback_query` — the title picker's button
 * presses), `sendMessage`, `sendDocument`, `sendPhoto`, `editMessageCaption`,
 * `answerCallbackQuery`, `setMyCommands`. No webhook, no port.
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
 * morning report itself (each message must fit whole — `report.ts` caps it by `visibleLength`,
 * and `messageParts` sends it whole), but a long `/health` answer still arrives.
 */
export function splitMessage(text: string, max = MESSAGE_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const softCut = rest.lastIndexOf("\n", max);
    let cut = softCut > max / 2 ? softCut : max;
    if (cut === max) {
      // A hard cut never halves an emoji's surrogate pair (a lone one is not valid UTF-8 to
      // Telegram) or an HTML entity ("&l" | "t;").
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1]!)) cut--;
      const amp = rest.lastIndexOf("&", cut - 1);
      if (amp > 0 && amp > cut - 8 && !rest.slice(amp, cut).includes(";")) cut = amp;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** What Telegram counts against the 4096: the text after its HTML is parsed — tags out, entities one character. */
export const visibleLength = (html: string): number =>
  html.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|amp|quot|#39);/g, "x").length;

/**
 * The messages `text` goes out as. An HTML message that fits once parsed goes whole: its markup
 * can push the raw length past the limit (the comments' links), and a raw cut would split its
 * `<blockquote>` in two, which Telegram refuses.
 */
export function messageParts(text: string, html = false): string[] {
  return html && visibleLength(text) <= MESSAGE_MAX_CHARS ? [text] : splitMessage(text);
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
  /** Telegram's `disable_notification`: delivered without a sound or vibration. */
  silent?: boolean;
  /** Inline buttons under the message (its last part, when split) — the growth line's "More". */
  keyboard?: InlineKeyboard;
}

/** Sends `text` to the operator's chat, split at `MESSAGE_MAX_CHARS`. Throws if not configured. */
export async function sendMessage(text: string, opts: SendOptions = {}): Promise<void> {
  if (opts.dryRun) {
    console.log(text);
    return;
  }
  const chat = chatId();
  if (!chat) throw new Error("TELEGRAM_CHAT_ID is not set");
  const parts = messageParts(text, opts.html);
  for (const [i, part] of parts.entries()) {
    await call("sendMessage", {
      chat_id: chat,
      text: part,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      disable_web_page_preview: opts.preview !== true,
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.keyboard && i === parts.length - 1 ? { reply_markup: opts.keyboard } : {}),
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

/** One row of inline buttons under a message — the title picker's options plus "New options". */
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface SendPhotoResult {
  message_id: number;
}

/** A local image as a photo with a caption and (optionally) inline buttons — the title picker's
 *  thumbnail offer. Caption capped at 1024 chars, same as `sendDocument`'s. */
export async function sendPhoto(
  filePath: string,
  caption: string,
  opts: { html?: boolean; keyboard?: InlineKeyboard } = {},
): Promise<SendPhotoResult> {
  const tok = token();
  const chat = chatId();
  if (!tok || !chat) throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
  const form = new FormData();
  form.set("chat_id", chat);
  form.set("caption", caption.slice(0, 1024));
  if (opts.html) form.set("parse_mode", "HTML");
  if (opts.keyboard) form.set("reply_markup", JSON.stringify(opts.keyboard));
  const buf = await readFile(filePath);
  form.set("photo", new Blob([new Uint8Array(buf)]), path.basename(filePath));
  const res = await fetch(`${API}/bot${tok}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: SendPhotoResult;
    description?: string;
  } | null;
  if (!json?.ok || !json.result)
    throw new TelegramApiError(`Telegram sendPhoto: ${json?.description ?? res.status}`, res.status);
  return json.result;
}

/**
 * Edits a photo message's caption and/or its inline keyboard. Omitting `opts.keyboard` clears it
 * (Telegram's own default is to leave an existing one alone, which no caller here wants: a saved
 * or auto-saved offer always loses its buttons, and a refresh always replaces them with the
 * fresh set) — pass one to set a new keyboard instead of removing it.
 */
export async function editMessageCaption(
  chat: string | number,
  messageId: number,
  caption: string,
  opts: { html?: boolean; keyboard?: InlineKeyboard } = {},
): Promise<void> {
  await call("editMessageCaption", {
    chat_id: chat,
    message_id: messageId,
    caption: caption.slice(0, 1024),
    ...(opts.html ? { parse_mode: "HTML" } : {}),
    reply_markup: opts.keyboard ?? { inline_keyboard: [] },
  });
}

/** Clears the "loading" spinner on a pressed button, optionally with a short toast. Never thrown
 *  on past this call's own `call()` — titlePicker.ts wraps every use so a malformed callback or a
 *  dropped connection here never takes the poller down. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  date: number;
}

/** A button press under a message this bot sent — the title picker's buttons only, so far. */
export interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Long-poll for updates since `offset`. `timeoutSec` should stay under the HTTP client's own timeout. */
export function getUpdates(offset: number | undefined, timeoutSec = 50): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
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
