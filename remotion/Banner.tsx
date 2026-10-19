import React from "react";
import { AbsoluteFill } from "remotion";
import { BOTTOM_BAND_Y, META_COL_WIDTH, SPLITS_COL_WIDTH, STAGE_WIDTH, TOP_BAND_HEIGHT } from "./layout.js";
import "./overlay.css";

export type BannerProps = {
  /** src/pipeline/banners.ts; "title" is the cold open's (src/pipeline/coldOpen.ts). */
  kind: "stakes" | "comingUp" | "explain" | "gap" | "title";
  head: string;
  text: string;
};

const EDGE = "#0d0c10";
const panel: React.CSSProperties = {
  position: "absolute",
  background: "rgba(34, 31, 39, 0.91)",
  border: `3px solid ${EDGE}`,
  borderTop: "8px solid #f0c93d",
  boxShadow: `6px 6px 0 ${EDGE}`,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  fontFamily: "var(--pixel-font)",
  fontWeight: 700,
  whiteSpace: "pre-line",
};
const gold = (size: number): React.CSSProperties => ({
  fontSize: size,
  color: "#f0c93d",
  textShadow: `5px 5px 0 ${EDGE}`,
  lineHeight: 1.15,
});
const quartz = (size: number): React.CSSProperties => ({
  fontSize: size,
  color: "#f3ede2",
  textShadow: `4px 4px 0 ${EDGE}`,
  lineHeight: 1.25,
});

/** Monocraft's advance is ~0.68 em: the largest size up to `max` that keeps `rows` rows of `text` inside `width`. */
const fitPx = (text: string, max: number, width: number, rows: number) =>
  Math.min(max, Math.floor(width / (Math.ceil(text.length / rows) * 0.68)));

/**
 * One of the retention opening's big lines, as a transparent full-frame still `export:fast` lays
 * over the finished frame. Sizes are the prototype's (19 Oct 2026), read at phone width; every
 * one stays above the bottom 8% (YouTube's progress bar) and off the top-right corner.
 */
export const Banner: React.FC<BannerProps> = ({ kind, head, text }) => {
  if (kind === "stakes")
    return (
      <AbsoluteFill>
        <div style={{ ...panel, left: 200, right: 200, top: 830, height: 160, gap: 10 }}>
          <span style={gold(52)}>{head}</span>
          <span style={quartz(52)}>{text}</span>
        </div>
      </AbsoluteFill>
    );
  if (kind === "comingUp")
    // Over the splits column, still empty right after match start.
    return (
      <AbsoluteFill>
        <div
          style={{
            ...panel,
            left: META_COL_WIDTH + 16,
            width: SPLITS_COL_WIDTH - 32,
            top: BOTTOM_BAND_Y + 26,
            height: 180,
            gap: 14,
          }}
        >
          <span style={gold(48)}>{head}</span>
          <span style={quartz(40)}>{text}</span>
        </div>
      </AbsoluteFill>
    );
  if (kind === "explain")
    // Top centre of the POVs, across the seam.
    return (
      <AbsoluteFill>
        <div
          style={{ ...panel, left: 460, right: 460, top: TOP_BAND_HEIGHT + 14, padding: "14px 24px 18px" }}
        >
          <span style={gold(50)}>{head}</span>
          <span style={quartz(38)}>{text}</span>
        </div>
      </AbsoluteFill>
    );
  if (kind === "gap")
    // Mid-POV on the seam, neutral edge: the colour of neither side.
    return (
      <AbsoluteFill style={{ alignItems: "center" }}>
        <div style={{ ...panel, top: 560, height: 80, padding: "0 36px", borderTop: "8px solid #8d8695" }}>
          <span style={quartz(40)}>{text}</span>
        </div>
      </AbsoluteFill>
    );
  // The cold open's title: the whole width just under the top band, so the stats stay in view.
  const size = text.length * 0.68 * 84 <= STAGE_WIDTH - 120 ? 84 : fitPx(text, 72, STAGE_WIDTH - 120, 2);
  return (
    <AbsoluteFill>
      <div style={{ ...panel, left: 30, right: 30, top: TOP_BAND_HEIGHT + 10, padding: "12px 30px 16px" }}>
        <span style={{ ...gold(size), textShadow: `6px 6px 0 ${EDGE}`, textWrap: "balance" }}>{text}</span>
      </div>
    </AbsoluteFill>
  );
};
