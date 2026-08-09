import { buildBadgeRingCells, BADGE_GRID_N } from "./pixelBadge.js";

// Computed once at module load, not per frame — this is static across the render.
const RING_CELLS = buildBadgeRingCells();

const QUARTZ = "#f3ede2";
const QUARTZ_SHADE = "#615f5a"; // darker shade of QUARTZ, not flat black -> reads as a 3D bevel

// MC/SR monogram: a 2x2 grid of square cells (each letter horizontally
// stretched to roughly match its own height), slightly overlapping so the
// outlines fuse into one block, sized to sit on top of the ring rather
// than confined inside its empty center.
const CELL = 26;
const GAP = -1.5;
const FONT_SIZE = 22;
const STRETCH_X = 1.55;
const STROKE_WIDTH = 2;

const BLOCK = CELL * 2 + GAP;
const X0 = (BADGE_GRID_N - BLOCK) / 2;
const Y0 = (BADGE_GRID_N - BLOCK) / 2;

const LETTERS: { ch: string; cx: number; cy: number }[] = [
  { ch: "M", cx: X0 + CELL / 2, cy: Y0 + CELL / 2 },
  { ch: "C", cx: X0 + CELL + GAP + CELL / 2, cy: Y0 + CELL / 2 },
  { ch: "S", cx: X0 + CELL / 2, cy: Y0 + CELL + GAP + CELL / 2 },
  { ch: "R", cx: X0 + CELL + GAP + CELL / 2, cy: Y0 + CELL + GAP + CELL / 2 },
];

/** The MCSR Replayoffs mark: a pixel-art replay/refresh ring (two arcs,
 * each capped with an arrowhead) with an MC/SR monogram on top, in
 * Monocraft. Shared by the video overlay and the thumbnail generator so
 * both carry the same badge. */
export function PixelBadge() {
  return (
    <div className="badge">
      <svg viewBox={`0 0 ${BADGE_GRID_N} ${BADGE_GRID_N}`}>
        {RING_CELLS.map((cell, i) => (
          <rect key={i} x={cell.x} y={cell.y} width={1} height={1} fill={cell.color} />
        ))}
        {LETTERS.map(({ ch, cx, cy }) => (
          <text
            key={ch}
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Monocraft, monospace"
            fontWeight={700}
            fontSize={FONT_SIZE}
            fill={QUARTZ}
            stroke={QUARTZ_SHADE}
            strokeWidth={STROKE_WIDTH}
            strokeLinejoin="round"
            paintOrder="stroke"
            transform={`translate(${cx} ${cy}) scale(${STRETCH_X} 1) translate(${-cx} ${-cy})`}
          >
            {ch}
          </text>
        ))}
      </svg>
    </div>
  );
}
