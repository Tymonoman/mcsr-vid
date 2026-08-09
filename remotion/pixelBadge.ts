/** Pixel-art replay/rewind ring: the MCSR Replayoffs mark. Grid cells only —
 * the "MCSR" wordmark itself is drawn as real Monocraft `<text>` by the
 * caller, not part of this grid. */

export type BadgeCell = { x: number; y: number; color: string };

export const BADGE_GRID_N = 32;

const CRIMSON = "#e2483f";
const WARPED = "#35d6c4";

const GAP_START = 300;
const GAP_END = 345;

// Angular span (degrees) the arrowhead tip extends into the gap from
// GAP_END, and how much wider than the ring it bulges at its base.
const ARROW_SPAN = 34;
const ARROW_BULGE = 2.4;

export function buildBadgeRingCells(n = BADGE_GRID_N): BadgeCell[] {
  const cells: BadgeCell[] = [];
  const c = (n - 1) / 2;
  const outerR = n * 0.46;
  const innerR = n * 0.3;
  const midR = (innerR + outerR) / 2;
  const halfThickness = (outerR - innerR) / 2;
  const arrowStart = GAP_END - ARROW_SPAN;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

      const inRing = dist >= innerR && dist <= outerR && !(angle >= GAP_START && angle <= GAP_END);

      // Arrowhead: a wedge that's widest (a bit wider than the ring
      // itself) where it joins the ring at GAP_END, tapering to a point
      // at arrowStart — same per-pixel radius/angle test as the ring
      // itself, so it's always solid and continuous, never a separate
      // shape that can drift out of alignment or rasterize as dots.
      let inArrow = false;
      if (angle > arrowStart && angle <= GAP_END) {
        const t = (GAP_END - angle) / ARROW_SPAN; // 0 at the ring join, 1 at the tip
        const wedgeHalfThickness = halfThickness * ARROW_BULGE * (1 - t);
        inArrow = dist >= midR - wedgeHalfThickness && dist <= midR + wedgeHalfThickness;
      }

      if (inRing || inArrow) {
        cells.push({ x, y, color: x < c ? WARPED : CRIMSON });
      }
    }
  }

  return cells;
}
