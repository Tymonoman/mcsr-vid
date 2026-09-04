import type { SplitRow } from "./overlayProps.js";
import type { KdenliveMarkerInput } from "./kdenliveProject.js";

/**
 * Kdenlive guides for each split, plus one carrying the sync verdict.
 *
 * Split times are match-start-relative (`computeSplits` reads `match.timelines[].time`), and
 * match start sits at `anchorSec` on the timeline, so a split's position is simply
 * `anchorSec + ms/1000`.
 *
 * This was inline in pipeline.ts as `maxOffset - clip.matchOffsetIntoClipSec + ms/1000`, which
 * cancelled to roughly `ms/1000` because maxOffset *was* the POV clip's offset — putting every
 * guide about 150 seconds early, near the head of the timeline instead of on the split. It is a
 * pure function here so that it can be tested; nothing covered it before.
 */
export function buildSplitMarkers(opts: {
  splits: SplitRow[];
  anchorSec: number;
  leftNickname: string;
  rightNickname: string;
}): KdenliveMarkerInput[] {
  const { splits, anchorSec, leftNickname, rightNickname } = opts;
  const markers: KdenliveMarkerInput[] = [];
  for (const row of splits) {
    for (const [ms, nickname] of [
      [row.leftMs, leftNickname],
      [row.rightMs, rightNickname],
    ] as const) {
      if (ms === null) continue;
      markers.push({ positionSec: anchorSec + ms / 1000, comment: `${row.label} — ${nickname}` });
    }
  }
  return markers;
}
