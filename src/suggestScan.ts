/**
 * Keeps one match-suggestion scan running for the whole dashboard process.
 *
 * The TUI holds this state in React (tui.tsx), which a server cannot reuse, so it lives here
 * rather than in server.ts — that file is transport and anything stateful in it is a bug.
 *
 * The scan starts at boot rather than when someone opens the suggestions panel, copying the
 * TUI's deliberate choice to scan in the background while you are still on the input screen: a
 * cold scan pages the MCSR feed dozens of times, and suggestions that appear a minute after you
 * ask for them are suggestions you have already navigated away from.
 */
import { describeError } from "./errorText.js";
import {
  dismissSuggestion,
  getSuggestions,
  restoreSuggestion,
  type SuggestResult,
  type Suggestion,
} from "./suggest.js";

export interface SuggestSnapshot {
  /** Null until the first scan finishes; a stale result is kept while a rescan runs. */
  result: SuggestResult | null;
  scanning: boolean;
  /** Why the last scan failed, or null. A failed scan keeps any previous result visible. */
  error: string | null;
  /** Live counters from the scan in flight, for a progress line. */
  scanned: number;
  candidates: number;
  /** Epoch ms the current result was produced, or null. */
  scannedAtMs: number | null;
}

const state: SuggestSnapshot = {
  result: null,
  scanning: false,
  error: null,
  scanned: 0,
  candidates: 0,
  scannedAtMs: null,
};

/** Guards against a second scan: they share one cache file and would double-count appearances. */
let inFlight: Promise<void> | null = null;

export function startScan(force = false): Promise<void> {
  if (inFlight) return inFlight;

  state.scanning = true;
  state.error = null;
  state.scanned = 0;
  state.candidates = 0;

  inFlight = getSuggestions({
    force,
    onProgress: (scanned, candidates) => {
      state.scanned = scanned;
      state.candidates = candidates;
    },
  })
    .then((result) => {
      state.result = result;
      // The cache's time, not now: an unforced scan on a fresh cache walks nothing, and the
      // scan line's "scanned 16h ago" must not reset to "0m ago" on every 30-minute tick.
      state.scannedAtMs = result.scannedAt;
    })
    .catch((err: unknown) => {
      // A flaky feed must not clear a good previous list — a stale suggestion is still a
      // renderable match, and the error is reported alongside it rather than instead of it.
      state.error = describeError(err);
    })
    .finally(() => {
      state.scanning = false;
      inFlight = null;
    });

  return inFlight;
}

export function snapshot(): SuggestSnapshot {
  return { ...state };
}

/** Rows dropped by `dismiss`, kept so `restore` can put them back without a scan. */
const parked = new Map<number, Suggestion>();

/**
 * Hides a match. `dismissSuggestion` writes the cache, but the in-memory result would keep
 * serving the row until the next scan, so it is dropped here too — and parked, for the undo.
 */
export function dismiss(matchId: number): void {
  dismissSuggestion(matchId);
  if (state.result) {
    const row = state.result.suggestions.find((s) => s.metrics.matchId === matchId);
    if (row) parked.set(matchId, row);
    state.result = {
      ...state.result,
      suggestions: state.result.suggestions.filter((s) => s.metrics.matchId !== matchId),
    };
  }
}

/**
 * Un-dismisses a match. True when the row is showing again now; false when this process never
 * saw it (a restart since), in which case it is back after the next scan. Order is not a
 * concern here: `presentSuggestions` sorts each bucket on every read.
 */
export function restore(matchId: number): boolean {
  const row = parked.get(matchId);
  restoreSuggestion(matchId, row);
  if (!row) return false;
  parked.delete(matchId);
  if (state.result) state.result = { ...state.result, suggestions: [...state.result.suggestions, row] };
  return true;
}
