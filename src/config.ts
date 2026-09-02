import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./matchScore.js";

export interface Config {
  /** Starlight Skins pose name for the left/right player's avatar (overlay + thumbnail). */
  leftPose: string;
  rightPose: string;
  /** Minimum cross-correlation confidence (sync.ts) to trust the refined audio sync offset. */
  syncConfidenceThreshold: number;
  /** VOD trim window: seconds of buffer before/after the estimated match start/end. */
  preRollSec: number;
  postRollSec: number;
  /** Fallback run length (sec) when match.result.time is missing/zero (e.g. forfeits). */
  defaultRunSec: number;
  /** Per-match working directory root. */
  mediaDir: string;
  /**
   * Seconds of overlay before the timer starts. The VOD clips keep a much larger `preRollSec`
   * because the audio-sync search needs room to hunt for the world-load thump, but the overlay
   * just sits frozen at 0:00.000 through all of it — so it only renders a short lead-in.
   */
  overlayLeadInSec: number;
  /**
   * Frame rate of the overlay render. The overlay is 2D graphics composited over 60fps
   * footage, so 30 halves render time and file size for no visible loss; raise to 60 only
   * if you can see the RTA timer's millisecond digits stepping.
   */
  overlayFps: number;
  /**
   * Parallel browser tabs used to render frames. null = Remotion's default (~half your
   * cores). Each tab holds a full 1080p page, so on a RAM-tight machine a *lower* number
   * renders faster than a higher one by avoiding swap.
   */
  renderConcurrency: number | null;
  /**
   * Suggestion slots per bucket. Close races and entertaining messes are ranked
   * separately so a run of very tight matches can't crowd the funny ones off the list.
   */
  suggestCloseSlots: number;
  suggestChaosSlots: number;
  /** Reuse the cached suggestion list for this long before rescanning. */
  suggestCacheTtlMin: number;
  /**
   * Caps on a single scan. Only ~2% of ranked matches have the two VODs the pipeline
   * needs, so the feed is paged (100 matches per request) until enough candidates turn
   * up; each survivor then costs one more request for its timeline. Worst case here is
   * ~65 requests against a 500-per-10-minute budget.
   */
  suggestMaxScanRequests: number;
  suggestDetailFetchLimit: number;
  /**
   * Speed scoring: a run at or under `fast` earns the full bonus, decaying to nothing at
   * `slow`. Deliberately only one term among several — the best-performing video so far
   * was a 10:22 that won on a one-second finish.
   */
  suggestFastRunTargetSec: number;
  suggestSlowRunCutoffSec: number;
  /**
   * How much a player's Twitch following counts toward "popular", on top of how often
   * they turn up streaming ranked matches. Applied to `log10(1 + followers)` because
   * follower counts are heavy-tailed: at weight 3, 1k followers is worth ~9 and 100k
   * ~15, comparable to the range raw appearance counts span. Needs
   * `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`; without them popularity is
   * appearances-only and this is ignored.
   */
  suggestFollowerWeight: number;
  /** Per-term weights for the closeness and chaos scores. */
  suggestWeights: ScoreWeights;
}

const DEFAULTS: Config = {
  leftPose: "walking",
  rightPose: "crossed",
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  postRollSec: 60,
  defaultRunSec: 900,
  mediaDir: "media",
  overlayLeadInSec: 20,
  overlayFps: 30,
  renderConcurrency: null,
  suggestCloseSlots: 8,
  suggestChaosSlots: 2,
  suggestCacheTtlMin: 30,
  suggestMaxScanRequests: 40,
  // Measured: only ~10% of dual-VOD matches have a comparable finish (usually the loser
  // stops once the winner is done), so filling eight close slots needs a shortlist well
  // past eight. 120 detail fetches plus ~40 feed pages is ~160 of the 500-per-10-min
  // budget.
  suggestDetailFetchLimit: 120,
  suggestFastRunTargetSec: 420,
  suggestSlowRunCutoffSec: 600,
  suggestFollowerWeight: 3,
  suggestWeights: DEFAULT_WEIGHTS,
};

const CONFIG_PATH = path.resolve("mcsr-vid.config.json");

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    ...DEFAULTS,
    ...raw,
    // The spread above is shallow, so overriding one weight would drop all the others.
    suggestWeights: { ...DEFAULTS.suggestWeights, ...(raw.suggestWeights ?? {}) },
  };
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();
