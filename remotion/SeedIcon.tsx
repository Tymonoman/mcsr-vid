import React from "react";
import { SEED_ICON_GRIDS, SEED_ICON_PALETTE } from "./seedIconArt.js";

export interface SeedIconProps {
  type: string | null;
  size: number;
}

export const SeedIcon: React.FC<SeedIconProps> = ({ type, size }) => {
  if (!type) {
    return null;
  }

  const grid = SEED_ICON_GRIDS[type];
  if (!grid) {
    return null;
  }

  const gridSize = grid.length;
  const cellSize = size / gridSize;

  // We optimize rendering by combining consecutive pixels of the same color on a row into a single <rect>
  const rects: React.ReactElement[] = [];

  for (let y = 0; y < gridSize; y++) {
    const row = grid[y];
    let startX = -1;
    let currentColor = "";

    const addRect = (x: number) => {
      if (startX !== -1 && currentColor !== "" && currentColor !== "transparent") {
        const width = x - startX;
        rects.push(
          <rect
            key={`${y}-${startX}`}
            x={startX * cellSize}
            y={y * cellSize}
            width={width * cellSize}
            height={cellSize}
            fill={currentColor}
            shapeRendering="crispEdges"
          />
        );
      }
    };

    for (let x = 0; x < gridSize; x++) {
      const char = row[x];
      const color = SEED_ICON_PALETTE[char];

      if (color !== currentColor) {
        addRect(x);
        startX = x;
        currentColor = color || "transparent";
      }
    }
    addRect(gridSize);
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {rects}
      <rect 
        x={cellSize / 2} 
        y={cellSize / 2} 
        width={size - cellSize} 
        height={size - cellSize} 
        fill="none" 
        stroke="#0d0c10" 
        strokeWidth={cellSize} 
      />
      <rect
        x={cellSize + 0.5}
        y={cellSize + 0.5}
        width={size - 2 * cellSize - 1}
        height={size - 2 * cellSize - 1}
        fill="none"
        stroke="#3c3844"
        strokeWidth={1}
      />
    </svg>
  );
};
