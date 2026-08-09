import { buildBadgeRingCells, BADGE_GRID_N } from "./pixelBadge.js";

// Computed once at module load, not per frame — this is static across the render.
const RING_CELLS = buildBadgeRingCells();

/** The MCSR RePlayoffs mark: a pixel-art replay ring around the Monocraft
 * wordmark, in the crimson/warped brand split. Shared by the video overlay
 * and the thumbnail generator so both carry the same badge. */
export function PixelBadge() {
  return (
    <div className="badge">
      <svg viewBox={`0 0 ${BADGE_GRID_N} ${BADGE_GRID_N}`}>
        {RING_CELLS.map((cell, i) => (
          <rect key={i} x={cell.x} y={cell.y} width={1} height={1} fill={cell.color} />
        ))}
        <text
          x={BADGE_GRID_N / 2}
          y={BADGE_GRID_N / 2 + 0.5}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Monocraft, monospace"
          fontWeight={700}
          fontSize={BADGE_GRID_N * 0.2}
          fill="#f3ede2"
        >
          MCSR
        </text>
      </svg>
    </div>
  );
}
