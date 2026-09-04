import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./matchScore.js";

export interface Config {
  /** Starlight Skins pose name for the left/right player's avatar (overlay + thumbnail). */
  leftPose: string;
  rightPose: string;
  /**
   * Pose pairs rendered as thumbnail variants on every pipeline run, for A/B testing which
   * poses earn clicks. The first entry is what `thumbnail.png` becomes unless you pick another
   * in the dashboard, so keep `leftPose`/`rightPose` first to preserve the current look.
   *
   * The non-default pairs are unverified: Starlight Skins' `/render/<pose>/<uuid>/full` returns
   * 404 for every pose at the time of writing, so there is no way to confirm which names it
   * still accepts, and each variant currently falls back to the same static NMSR render. The
   * dashboard labels those as fallbacks rather than pretending they are distinct poses. Re-check
   * these names once the service is back, and treat CTR grouped by pose as meaningless until
   * the variants are visibly different.
   */
  thumbnailVariants: Array<{ left: string; right: string }>;
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
   * The channel uploads go to. Used to tell your own replies apart from viewers' when deciding
   * which comment threads are still unanswered.
   */
  youtubeChannelId: string;
  /**
   * Standing YouTube Reporting API job producing `channel_reach_basic_a1`. That report is the
   * only source of per-video thumbnail impressions and CTR — the Analytics API does not expose
   * them — so thumbnail A/B testing reads this and nothing else. Reports land ~48h after the
   * day they cover, so a video uploaded today will have no row yet.
   */
  youtubeReportingJobId: string;
  /**
   * Seconds of overlay before the RTA timer starts.
   *
   * This is also where the published video begins: the timeline is anchored on the world-load
   * thump (kdenliveProject.ANCHOR_SEC), so an overlay lead-in equal to that anchor puts the
   * overlay, the intro and the footage all at timeline 0 with nothing trimmed. Changing it
   * away from 10 makes the overlay clips get head-trimmed to keep match start in place, which
   * is correct but wastes render, and an intro shorter than the difference is rejected outright.
   *
   * The VOD clips keep a much larger `preRollSec` because the audio-sync search needs room to
   * hunt for the thump; that headroom is trimmed off the timeline rather than shown.
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
  thumbnailVariants: [
    // First is the existing look, so nothing changes for a match already published.
    { left: "walking", right: "crossed" },
    { left: "cheering", right: "relaxing" },
    { left: "marching", right: "crouching" },
  ],
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  postRollSec: 60,
  defaultRunSec: 900,
  mediaDir: "media",
  youtubeChannelId: "UCm2mAyONTHlmIxZzNmi388w",
  youtubeReportingJobId: "eda017ae-a539-4c79-8e2c-66d1af74264a",
  overlayLeadInSec: 10,
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

/**
 * The config file is hand-edited, so a wrong type (`"renderConcurrency": "4"`) would otherwise be
 * spread straight into `Config` and surface far from the cause — as string concatenation in slot
 * arithmetic, or a bad option handed to the Remotion renderer. Check each override against the
 * type of the default it replaces and fail here, naming the key.
 */
export function validateOverrides(raw: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      throw new Error(`${CONFIG_PATH}: unknown key "${key}".`);
    }
    const expected = DEFAULTS[key as keyof Config];
    if (key === "suggestWeights") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${CONFIG_PATH}: "suggestWeights" must be an object.`);
      }
      for (const [wKey, wValue] of Object.entries(value)) {
        if (!(wKey in DEFAULTS.suggestWeights)) {
          throw new Error(`${CONFIG_PATH}: unknown suggestWeights key "${wKey}".`);
        }
        if (typeof wValue !== "number" || !Number.isFinite(wValue)) {
          throw new Error(`${CONFIG_PATH}: suggestWeights."${wKey}" must be a finite number.`);
        }
      }
      continue;
    }
    // renderConcurrency is the one key whose default is null and whose override is a number.
    if (expected === null) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be a finite number or null.`);
      }
      continue;
    }
    if (typeof value !== typeof expected) {
      throw new Error(
        `${CONFIG_PATH}: "${key}" must be a ${typeof expected}, got ${value === null ? "null" : typeof value}.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${CONFIG_PATH}: "${key}" must be a finite number.`);
    }
  }
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object.`);
  }
  const raw = parsed as Record<string, unknown>;
  validateOverrides(raw);
  return {
    ...DEFAULTS,
    ...raw,
    // The spread above is shallow, so overriding one weight would drop all the others.
    suggestWeights: {
      ...DEFAULTS.suggestWeights,
      ...((raw.suggestWeights as Partial<ScoreWeights>) ?? {}),
    },
  } as Config;
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();
