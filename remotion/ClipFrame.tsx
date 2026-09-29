import type { FC } from "react";
import { AbsoluteFill } from "remotion";
import "./overlay.css";
import type { ClipFrameProps } from "./types.js";
import { PixelBadge } from "./PixelBadge.js";
import { clipTitleFit } from "./layout.js";

/**
 * The reusable frame for a standalone clip (a stream statement, a reaction) rather than a match
 * render: a title band across the top and a framed window in the middle, in the channel's own
 * thumbnail/overlay look. `src/clips/clipCli.ts` renders this as a transparent PNG and composites
 * the source video into the window underneath it, so the rect below has to be the only place
 * either side defines it — CLIP_WINDOW_* in layout.ts, mirrored here as literal px in
 * overlay.source.css's `.clipframe-*` rules and pinned to it by layout.test.ts.
 *
 * The window itself is left undrawn — not painted over, not masked — by tiling the ground/checker
 * background in three regions *around* it (`.clipframe-ground.left/right/bottom`; the band above
 * already fills the fourth side). The same technique the match overlay uses to leave the POV gap
 * transparent between its top and bottom bands (see layout.ts). Anything drawn across the window
 * rect would opaque over the video ffmpeg composites underneath.
 */
export const ClipFrame: FC<ClipFrameProps> = ({ title, speaker, when, credit }) => {
  const { lines, fontSizePx } = clipTitleFit(title);

  return (
    <AbsoluteFill className="clipframe">
      <div className="clipframe-band">
        <div className="clipframe-title" style={{ fontSize: fontSizePx }}>
          {lines.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </div>
      </div>
      <div className="clipframe-ground left" />
      <div className="clipframe-ground right" />
      <div className="clipframe-ground bottom" />
      <div className="clipframe-window" />
      <div className="clipframe-tag">
        <span className="name">{speaker}</span>
        <span className="when">{when}</span>
      </div>
      <span className="clipframe-credit">{credit}</span>
      <div className="clipframe-logo">
        <PixelBadge variant="ov" />
      </div>
    </AbsoluteFill>
  );
};
