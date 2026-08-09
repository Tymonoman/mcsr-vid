import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
};

const CONFIG_PATH = path.resolve("mcsr-vid.config.json");

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return { ...DEFAULTS, ...raw };
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();
