import React from "react";
import { AbsoluteFill } from "remotion";
import { BOTTOM_BAND_Y, TOP_BAND_HEIGHT } from "./layout.js";
import "./overlay.css";

export const CountdownTeaser: React.FC<{ teaserText?: string }> = ({ 
  teaserText = "COMING UP · AT 5:14 · THE LEAD CHANGES ON BLIND TRAVEL" 
}) => {
  // Place between top band (Y=194) and bottom band (Y=734).
  // Height is 120. We can place it at BOTTOM_BAND_Y - 120 so it sits on top of the bottom band.
  // The center of each POV is at Y = 194 + (734-194)/2 = 464.
  // BOTTOM_BAND_Y - 120 = 734 - 120 = 614. (614 to 734).
  // This stays well below the 464 center.
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: BOTTOM_BAND_Y - 120,
          left: 0,
          right: 0,
          height: 120,
          backgroundColor: "rgba(26, 24, 32, 0.8)", // --panel-2
          borderTop: "4px solid #3c3844", // --panel-edge-light
          borderBottom: "4px solid #3c3844", // --panel-edge-light
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontFamily: '"Monocraft", ui-monospace, monospace',
            fontSize: "64px",
            color: "#f0c93d", // --gold
            textShadow: "4px 4px 0 #0d0c10", // --panel-edge
            letterSpacing: "0.06em",
          }}
        >
          {teaserText}
        </span>
      </div>
    </AbsoluteFill>
  );
};
