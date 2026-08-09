/** Pixel-art replay/refresh ring: the MCSR Replayoffs mark. Two arcs, each
 * capped with an arrowhead, at 180-degree rotational symmetry — the
 * classic "refresh/sync" icon shape. Grid cells only; the MC/SR monogram
 * is drawn separately by the caller (PixelBadge.tsx / generate_brand_assets.py). */

export type BadgeCell = { x: number; y: number; color: string };

export const BADGE_GRID_N = 64;

const CRIMSON = "#e2483f";
const WARPED = "#35d6c4";

// Two gaps (each with an arrowhead at its end), rotated 180 degrees from
// each other for perfect 2-fold symmetry.
const GAP1: [number, number] = [300, 345];
const GAP2: [number, number] = [120, 165];

// Angular span (degrees) each arrowhead tip extends into its gap, and how
// much wider than the ring it bulges at its base.
const ARROW_SPAN = 30;
const ARROW_BULGE = 2.2;

export function buildBadgeRingCells(n = BADGE_GRID_N): BadgeCell[] {
  const cells: BadgeCell[] = [];
  const c = (n - 1) / 2;
  const outerR = n * 0.46;
  const innerR = n * 0.3;
  const midR = (innerR + outerR) / 2;
  const halfThickness = (outerR - innerR) / 2;

  const inGap = (angle: number, gap: [number, number]) => angle >= gap[0] && angle <= gap[1];
  // Which of the two arcs a solid-ring angle belongs to (for per-arc color).
  const inArc1 = (angle: number) => angle > GAP1[1] || angle < GAP2[0];

  // Same per-pixel radius/angle wedge technique as the single-arrow
  // design: widest at the gap's end (a bit wider than the ring itself),
  // tapering to a point as it extends into the gap. Always solid and
  // continuous, never a separately rasterized shape.
  const arrowWedge = (angle: number, dist: number, gapEnd: number) => {
    const arrowStart = gapEnd - ARROW_SPAN;
    if (!(angle > arrowStart && angle <= gapEnd)) return false;
    const t = (gapEnd - angle) / ARROW_SPAN; // 0 at the ring join, 1 at the tip
    const half = halfThickness * ARROW_BULGE * (1 - t);
    return dist >= midR - half && dist <= midR + half;
  };

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

      const inRing = dist >= innerR && dist <= outerR && !inGap(angle, GAP1) && !inGap(angle, GAP2);
      const inArrow1 = arrowWedge(angle, dist, GAP1[1]);
      const inArrow2 = arrowWedge(angle, dist, GAP2[1]);
      if (!(inRing || inArrow1 || inArrow2)) continue;

      const arc1 = inArrow1 || (inRing && inArc1(angle));
      cells.push({ x, y, color: arc1 ? CRIMSON : WARPED });
    }
  }

  return cells;
}
