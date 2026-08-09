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
}

const DEFAULTS: Config = {
  leftPose: "walking",
  rightPose: "crossed",
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  postRollSec: 60,
  defaultRunSec: 900,
  mediaDir: "media",
};

const CONFIG_PATH = path.resolve("mcsr-vid.config.json");

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return { ...DEFAULTS, ...raw };
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();
