/**
 * `<mediaDir>/.telegram.json`: the one file that stops the morning report going out twice — a
 * restart, a chained "Run now" and the scheduled tick must never all send it — and carries the
 * previous channel snapshot forward so /stats and the report can say "+N since last time".
 *
 * Dot-prefixed and beside `.dashboard.json`/`.nightly.json` for the same reason those are: the
 * state travels with the media, not the checkout, and `listProcessedMatchIds` (every `^\d+$`
 * *directory*) never mistakes it for a match.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
   * The last clean "worth rendering" list and when it was gathered (ms), read for `WORTH_TTL_MS` —
   * a second report inside that spends nothing.
   */
  worth: { at: number; data: WorthFacts } | null;
}

const EMPTY: TelegramState = {
  lastReportWarsawDate: null,
  lastReportAt: null,
  prevSnapshot: null,
  updateOffset: null,
  worth: null,
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

/** Write-then-rename, so a crash mid-write never leaves a half-written file a later read trusts. */
export function writeTelegramState(state: TelegramState): void {
  if (dryRun) return;
  const file = statePath();
  writeFileSync(`${file}.part`, JSON.stringify(state, null, 2));
  renameSync(`${file}.part`, file);
}

export function updateTelegramState(change: (s: TelegramState) => void): TelegramState {
  const s = readTelegramState();
  change(s);
  writeTelegramState(s);
  return s;
}
