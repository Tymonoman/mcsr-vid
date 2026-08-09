import type { BadgeCell } from "./pixelBadge.js";

/** Pixel-art silhouette per bastion remnant type, in the project's own brand
 * palette — generated from a row pattern, not sourced from any external
 * icon set (no official one exists for these). Same "grid of cells" approach
 * as pixelBadge.ts, just simpler (row bitmaps instead of polar geometry). */

export const BASTION_GRID_N = 10;

const GOLD = "#f0c93d";
const WARPED = "#35d6c4";
const QUARTZ = "#f3ede2";
const MUTED = "#8d8695";

// ponytail: hand-authored row bitmaps, not detailed pixel art — good enough
// to read as a distinct silhouette per type at overlay scale. Upgrade path:
// tune individual rows below if a QA pass wants more detail.
const PATTERNS: Record<string, { rows: string[]; color: string }> = {
  HOUSING: {
    color: WARPED,
    rows: [
      "....##....",
      "...####...",
      "..######..",
      ".########.",
      "##########",
      "##......##",
      "##.####.##",
      "##.####.##",
      "##.####.##",
      "##########",
    ],
  },
  STABLES: {
    color: MUTED,
    rows: [
      "#........#",
      "#........#",
      "##########",
      "#........#",
      "#........#",
      "##########",
      "#........#",
      "#........#",
      "#........#",
      "##########",
    ],
  },
  TREASURE: {
    color: GOLD,
    rows: [
      ".########.",
      "#..####..#",
      "##########",
      "#........#",
      "#........#",
      "#...##...#",
      "#........#",
      "#........#",
      "#........#",
      "##########",
    ],
  },
  BRIDGE: {
    color: QUARTZ,
    rows: [
      "..........",
      "..........",
      "##########",
      "##......##",
      "##......##",
      "##......##",
      "##......##",
      "#........#",
      "#........#",
      "##########",
    ],
  },
};

/** Returns [] for an unrecognized/unknown bastion type — caller skips the icon. */
export function buildBastionIconCells(bastionType: string | null): BadgeCell[] {
  const pattern = bastionType ? PATTERNS[bastionType] : undefined;
  if (!pattern) return [];

  const cells: BadgeCell[] = [];
  pattern.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") cells.push({ x, y, color: pattern.color });
    }
  });
  return cells;
}
