/**
 * Where the match starts in each POV clip, read from the picture.
 *
 * The countdown is visible in each VOD on its own — the digit at the centre of the screen, and
 * the ten-second camera freeze on a client that locks it (src/countdownDetect.ts) — so each clip
 * is anchored absolutely, with no dependency on the two streams sharing anything. Opponents play
 * separate worlds with their own microphones and music: an audio cross-correlation between the
 * two was 12–32 s wrong on real footage and, kept as the fallback for a year, never once
 * answered on a match on disk ("AMBIGUOUS — kept coarse estimates" every time). It is gone; a
 * clip the picture cannot read keeps the download's coarse estimate at confidence 0, and the
 * dashboard's sync editor is where a human settles that.
 */
import { detectMatchStartAny, type MatchStartDetection } from "./countdownDetect.js";

/** How far either side of the coarse estimate the countdown is looked for. */
const DETECT_RADIUS_SEC = 25;

export interface SyncResult {
  /** Corrected time (sec) within clip A where match start falls. */
  clipACueTimeSec: number;
  /** Corrected time (sec) within clip B where match start falls. */
  clipBCueTimeSec: number;
  /**
   * 0-1, and comparable between matches: both clips read, one clip read (the other left on its
   * estimate), or nothing.
   */
  confidence: number;
  /** Which evidence there was, for the sync marker the editor sees. */
  detail: string;
}

/** Confidence at or above which a detection is trusted as an absolute anchor. */
const VIDEO_TRUSTED = 0.08;

export type MatchStartDetector = (
  clipPath: string,
  expectedStartSec: number,
  radiusSec: number,
  signal?: AbortSignal,
) => Promise<MatchStartDetection>;

export async function computeSyncOffset(
  clipAPath: string,
  clipBPath: string,
  expectedClipACueSec: number,
  expectedClipBCueSec: number,
  signal?: AbortSignal,
  detect: MatchStartDetector = detectMatchStartAny,
): Promise<SyncResult> {
  const [videoA, videoB] = await Promise.all([
    detect(clipAPath, expectedClipACueSec, DETECT_RADIUS_SEC, signal),
    detect(clipBPath, expectedClipBCueSec, DETECT_RADIUS_SEC, signal),
  ]);
  return fromVideo(videoA, videoB, expectedClipACueSec, expectedClipBCueSec);
}

/**
 * Both clips seen, one clip seen and the other left on its coarse estimate, or neither — then
 * both estimates stand at confidence 0, and the detail says what each detector saw.
 */
export function fromVideo(
  videoA: MatchStartDetection,
  videoB: MatchStartDetection,
  expectedA: number,
  expectedB: number,
): SyncResult {
  const okA = videoA.matchStartSec !== null && videoA.confidence >= VIDEO_TRUSTED;
  const okB = videoB.matchStartSec !== null && videoB.confidence >= VIDEO_TRUSTED;

  const describe = () =>
    `countdown A ${okA ? `${videoA.matchStartSec!.toFixed(2)}s (${videoA.detail})` : `not found (${videoA.detail})`}; ` +
    `B ${okB ? `${videoB.matchStartSec!.toFixed(2)}s (${videoB.detail})` : `not found (${videoB.detail})`}`;

  if (!okA && !okB) {
    return {
      clipACueTimeSec: expectedA,
      clipBCueTimeSec: expectedB,
      confidence: 0,
      detail: `no countdown read in either clip, kept coarse estimates — ${describe()}`,
    };
  }
  // Each clip is anchored on its own evidence, so one player tabbing out costs only that clip's
  // precision — it cannot drag the other POV out of alignment, which a purely relative sync
  // would have done.
  return {
    clipACueTimeSec: okA ? videoA.matchStartSec! : expectedA,
    clipBCueTimeSec: okB ? videoB.matchStartSec! : expectedB,
    confidence:
      okA && okB
        ? Math.min(1, 0.6 + Math.min(videoA.confidence, videoB.confidence))
        : Math.min(0.5, 0.3 + (okA ? videoA.confidence : videoB.confidence)),
    detail:
      okA && okB
        ? `video: both countdowns found — ${describe()}`
        : `video: one countdown found — ${describe()}`,
  };
}
