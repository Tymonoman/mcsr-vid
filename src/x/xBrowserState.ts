/**
 * `<mediaDir>/.x-browser.json`: what the browser poster (`src/x/xBrowser.ts`) last saw and did,
 * for `npm run x -- status` and the morning report's "Needs you". No browser import here, so the
 * Telegram bot's facts can read it without pulling Playwright into the dashboard process.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type XProbeResult = "ok" | "signed-out" | "verify" | "wrong-account" | "error";

export interface XBrowserState {
  lastProbe: XProbeResult | null;
  lastProbeAt: string | null;
  lastPostAt: string | null;
  lastError: string | null;
  /** When `lastError` was set: the tick makes one failed attempt a UTC day, then waits for the next. */
  lastErrorAt: string | null;
  lastMatchId: number | null;
  /** A Post click X never confirmed: that match's x.json stays `browser:pending` (it may have gone
   * out). Cleared by the tick once that x.json is settled (X's id in it, or deleted), or by the next
   * confirmed post. */
  unconfirmed: { matchId: number; at: string; error: string } | null;
  /** The worker's `--dry-run` drive runs at most once a UTC day. */
  lastDryRunAt: string | null;
}

export const EMPTY_X_BROWSER_STATE: XBrowserState = {
  lastProbe: null,
  lastProbeAt: null,
  lastPostAt: null,
  lastError: null,
  lastErrorAt: null,
  lastMatchId: null,
  unconfirmed: null,
  lastDryRunAt: null,
};

export const xBrowserStatePath = (): string => path.join(config.mediaDir, ".x-browser.json");

export function readXBrowserState(): XBrowserState | null {
  const file = xBrowserStatePath();
  if (!existsSync(file)) return null;
  try {
    return {
      ...EMPTY_X_BROWSER_STATE,
      ...(JSON.parse(readFileSync(file, "utf8")) as Partial<XBrowserState>),
    };
  } catch {
    return null;
  }
}

/** Merges `patch` over what is on disk (atomic write). A garbage file is replaced, not kept. */
export function updateXBrowserState(patch: Partial<XBrowserState>): XBrowserState {
  const next = { ...(readXBrowserState() ?? EMPTY_X_BROWSER_STATE), ...patch };
  mkdirSync(config.mediaDir, { recursive: true });
  const file = xBrowserStatePath();
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${file}.tmp`, file);
  return next;
}

/**
 * The "Needs you" lines (pure): nothing unless the flag is on and a state file exists; a session
 * the operator must fix by hand, a click X never confirmed, or the last attempt's error. A clean
 * probe with no error is quiet.
 */
export function xBrowserNeedsYou(state: XBrowserState | null, on: boolean): string[] {
  if (!on || !state) return [];
  const lines: string[] = [];
  if (state.lastProbe === "signed-out") lines.push("X: signed out, sign in with npm run x -- login");
  else if (state.lastProbe === "verify")
    lines.push("X: verification prompt, clear it over npm run x -- login (never automated)");
  else if (state.lastProbe === "wrong-account")
    lines.push(`X: the browser is not signed in as @${config.xHandle}, sign in with npm run x -- login`);
  if (state.unconfirmed)
    lines.push(
      `X: post may have gone out unconfirmed, check x.com/${config.xHandle} (match ${state.unconfirmed.matchId})`,
    );
  if (state.lastError) lines.push(`X post failed: ${state.lastError.split("\n")[0]}`);
  return lines;
}
