/**
 * `<mediaDir>/.telegram.json`: the one file that stops the morning report going out twice — a
 * restart, a chained "Run now" and the scheduled tick must never all send it — and carries the
 * previous channel snapshot forward so /stats and the report can say "+N since last time".
 *
 * Dot-prefixed and beside `.dashboard.json`/`.nightly.json` for the same reason those are: the
 * state travels with the media, not the checkout, and `listProcessedMatchIds` (every `^\d+$`
 * *directory*) never mistakes it for a match.
 */
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ChannelSnapshot } from "./facts.js";
import type { WorthFacts } from "./worth.js";

export interface TelegramState {
  /** The Warsaw calendar date (YYYY-MM-DD) the morning report last went out on. */
  lastReportWarsawDate: string | null;
  /** ISO 8601 UTC of the last report — "overnight" and "since the previous report" mean since here. */
  lastReportAt: string | null;
  /** The live channel counts as of the last report, for the "+N since last time" line. */
  prevSnapshot: ChannelSnapshot | null;
  /** Telegram's own update cursor — `getUpdates(offset)` — so a restart does not replay old commands. */
  updateOffset: number | null;
  /**
   * The last "worth rendering" list, with its notes, and when it was gathered (ms), read for
   * `WORTH_TTL_MS` — a second report inside that spends nothing.
   */
  worth: { at: number; data: WorthFacts } | null;
  /**
   * The title picker's pending offers (src/telegram/titlePicker.ts), keyed by matchId as a
   * string (JSON object keys always are). Doubles as the dedupe — a match in here is never
   * offered again — and as the per-match cache a button press reads its option's text back
   * from, since the title itself never travels in `callback_data` (Telegram's 64-byte cap).
   */
  titleOffers: Record<string, TitleOfferState>;
  /**
   * The fast-track ask's pending/sent messages (src/telegram/fastTrackAsk.ts), keyed by matchId
   * as a string — same dedupe shape as `titleOffers`: a match in here is never asked again.
   */
  fastTrackAsks: Record<string, FastTrackAskState>;
}

export interface FastTrackAskState {
  messageId: number;
  /** ISO 8601 UTC, when the ask was sent. */
  at: string;
  /** A button was pressed: the message's buttons are gone, and a stale press must not act again. */
  settled?: boolean;
}

export interface TitleOfferState {
  messageId: number;
  options: string[];
  source: ("nicknames" | "model" | "chip")[];
  /** ISO 8601 UTC, when the offer (or its last refresh) was sent. */
  at: string;
  /** A button was pressed, or auto-hooks saved first: the message's buttons are gone, and a
   *  stale press or a second auto-save must not try to act on it again. */
  settled?: boolean;
  /** ISO 8601 UTC of a veto press (`t:<id>:x`), not yet uploaded — the window the lone Undo
   *  button (`t:<id>:u`) still works in; cleared by Undo. Absent for the already-uploaded veto,
   *  which has no Undo. */
  vetoedAt?: string;
}

const EMPTY: TelegramState = {
  lastReportWarsawDate: null,
  lastReportAt: null,
  prevSnapshot: null,
  updateOffset: null,
  worth: null,
  titleOffers: {},
  fastTrackAsks: {},
};

const statePath = (): string => path.join(config.mediaDir, ".telegram.json");

/** Missing or corrupt both read as "no report ever sent" — the recoverable answer, as elsewhere in this repo. */
export function readTelegramState(): TelegramState {
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(statePath(), "utf8")) as Partial<TelegramState>) };
  } catch {
    return EMPTY;
  }
}

let dryRun = false;

/**
 * `npm run tg -- … --dry-run` prints and sends nothing, and must leave the media directory as it
 * found it: reads still work, writes are skipped.
 */
export const setStateDryRun = (on = true): void => {
  dryRun = on;
};

/**
 * Write-then-rename, so a crash mid-write never leaves a half-written file a later read trusts.
 * The temp name carries the pid: the dashboard's poller and a CLI `npm run tg` both write here,
 * and a shared `.part` let one process rename the other's away mid-write.
 */
export function writeTelegramState(state: TelegramState): void {
  if (dryRun) return;
  const file = statePath();
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(state, null, 2));
  renameSync(part, file);
}

export function updateTelegramState(change: (s: TelegramState) => void): TelegramState {
  const s = readTelegramState();
  change(s);
  writeTelegramState(s);
  return s;
}

/**
 * `<mediaDir>/.telegram-inbox.jsonl`: the operator's plain (non-command) replies, one JSON line
 * each, so a session that asked a question on Telegram can read the answer with `npm run tg --
 * inbox`. Appended by the dashboard's poller, read and cleared by the CLI — two processes, hence
 * an append per line rather than a read-modify-write.
 */
export interface InboxEntry {
  at: string;
  text: string;
  messageId: number;
}

const inboxPath = (): string => path.join(config.mediaDir, ".telegram-inbox.jsonl");

export function appendInbox(entry: InboxEntry): void {
  if (dryRun) return;
  appendFileSync(inboxPath(), `${JSON.stringify(entry)}\n`);
}

/** Oldest first; a line that does not parse is skipped. `clear` moves the file aside before
 *  reading, so a reply the poller appends mid-read starts a fresh file instead of being cut. */
export function readInbox(clear = false): InboxEntry[] {
  let file = inboxPath();
  if (clear && !dryRun) {
    try {
      renameSync(file, `${file}.taken`);
    } catch {
      return [];
    }
    file = `${file}.taken`;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (file.endsWith(".taken")) unlinkSync(file);
  return raw.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as InboxEntry] : [];
    } catch {
      return [];
    }
  });
}
