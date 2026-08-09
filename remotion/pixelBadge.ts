/** Pixel-art replay/rewind ring: the MCSR Replayoffs mark. Grid cells only —
 * the "MCSR" wordmark itself is drawn as real Monocraft `<text>` by the
 * caller, not part of this grid. */

export type BadgeCell = { x: number; y: number; color: string };

export const BADGE_GRID_N = 32;

const CRIMSON = "#e2483f";
const WARPED = "#35d6c4";

const GAP_START = 300;
const GAP_END = 345;

export function buildBadgeRingCells(n = BADGE_GRID_N): BadgeCell[] {
  const cells: BadgeCell[] = [];
  const c = (n - 1) / 2;
  const outerR = n * 0.46;
  const innerR = n * 0.3;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      if (dist < innerR || dist > outerR) continue;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 360;
      const normalized = angle % 360;
      if (normalized >= GAP_START && normalized <= GAP_END) continue;
      cells.push({ x, y, color: x < c ? WARPED : CRIMSON });
    }
  }

  // small flared tail at each gap end, reading as a rewind-arrow motion cue
  const tailR = outerR + 2;
  for (const angleDeg of [GAP_START - 6, GAP_START - 3, GAP_END + 3, GAP_END + 6]) {
    const rad = (angleDeg * Math.PI) / 180;
    const x = Math.round(c + tailR * Math.cos(rad));
    const y = Math.round(c + tailR * Math.sin(rad));
    if (x >= 0 && x < n && y >= 0 && y < n) {
      cells.push({ x, y, color: x < c ? WARPED : CRIMSON });
    }
  }

  return cells;
}
