import { buildBastionIconCells, BASTION_GRID_N } from "./bastionIcon.js";

/** Small pixel-art glyph for a match's bastion remnant type (Housing/Stables/
 * Treasure/Bridge). Renders nothing for an unrecognized/null type. */
export function BastionIcon({ bastionType }: { bastionType: string | null }) {
  const cells = buildBastionIconCells(bastionType);
  if (cells.length === 0) return null;

  return (
    <svg className="bastion-icon" viewBox={`0 0 ${BASTION_GRID_N} ${BASTION_GRID_N}`}>
      {cells.map((cell, i) => (
        <rect key={i} x={cell.x} y={cell.y} width={1} height={1} fill={cell.color} />
      ))}
    </svg>
  );
}
