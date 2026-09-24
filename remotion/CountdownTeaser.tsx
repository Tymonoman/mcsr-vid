import React from "react";
import { AbsoluteFill } from "remotion";
import { BOTTOM_BAND_Y, POV_HEIGHT, TOP_BAND_HEIGHT } from "./layout.js";
import { formatShortTime } from "./format.js";
import "./overlay.css";

export type CountdownTeaserProps = {
  /** src/pipeline/teaser.ts: when the moment happens, ms from match start. */
  momentMs: number;
  /** "THE LEAD CHANGES ON BLIND TRAVEL", at most TEASER_MAX_CHARS. */
  text: string;
};

/** Tall enough for two lines; its top stays this far below the POVs' centre line. */
const HEIGHT = 150;
/** The countdown digit sits at the POVs' vertical centre (a 96x72 crop, countdownDetect.ts). */
const POV_CENTRE_Y = TOP_BAND_HEIGHT + POV_HEIGHT / 2;

/**
 * The COMING UP line large over the countdown (config.countdownTeaser): a transparent full-frame
 * still `export:fast` lays over the stage from the intro card's end to match start. It sits on the
 * bottom of both POVs, over the hotbars, so the countdown digit at the centre of each stays clear.
 */
export const CountdownTeaser: React.FC<CountdownTeaserProps> = ({ momentMs, text }) => {
  const top = BOTTOM_BAND_Y - HEIGHT;
  if (top < POV_CENTRE_Y + 80) throw new Error("CountdownTeaser would cover the countdown digit");
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top,
          left: 0,
          right: 0,
          height: HEIGHT,
          background: "rgba(26, 24, 32, 0.88)",
          borderTop: "4px solid #3c3844",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          fontFamily: "var(--pixel-font)",
          textShadow: "4px 4px 0 #0d0c10",
        }}
      >
        <span style={{ fontSize: 40, color: "#f0c93d", letterSpacing: "0.08em" }}>
          COMING UP · AT {formatShortTime(momentMs)}
        </span>
        <span style={{ fontSize: 60, color: "#ffffff", letterSpacing: "0.04em" }}>{text}</span>
      </div>
    </AbsoluteFill>
  );
};
