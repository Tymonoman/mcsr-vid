import type { FC } from "react";
import { AbsoluteFill } from "remotion";
import "./overlay.css";
import { formatShortTime } from "./format.js";
import { PixelBadge } from "./PixelBadge.js";
import type { ShortProps } from "./types.js";
import { layoutShortHook } from "./shortHookLayout.js";
import {
  SHORT_BOTTOM_NAMEPLATE_Y,
  SHORT_BRAND_BAR_HEIGHT,
  SHORT_NAMEPLATE_HEIGHT,
  SHORT_POV_HEIGHT,
} from "./layout.js";

/**
 * The 1080x1920 Shorts board: a nameplate above each POV pane, and a channel bar pinned to the
 * bottom. The two gameplay panes are transparent holes the POV clips show through.
 *
 * Rendered as two *stills*, not video, for the same reason the 16:9 overlay is: nothing here
 * moves, and ffmpeg fades the hook out on its own. The one thing that would animate — a live
 * RTA counter — is a static "at m:ss" label instead, as on both reference channels.
 */

function Nameplate({
  nickname,
  eloRate,
  eloRank,
  side,
}: {
  nickname: string;
  eloRate: number;
  eloRank: number | null;
  side: "left" | "right";
}) {
  return (
    <div className={`short-plate ${side}`} style={{ height: SHORT_NAMEPLATE_HEIGHT }}>
      <PixelBadge />
      <div className="short-plate-text">
        <span className="short-name">{nickname}</span>
        <span className="short-elo">
          {eloRate} ELO{eloRank !== null && <span className="short-rank"> #{eloRank}</span>}
        </span>
      </div>
    </div>
  );
}

/** The board itself: everything that is on screen for the whole Short. */
export const Short: FC<ShortProps> = (props) => {
  return (
    <AbsoluteFill className="short">
      <Nameplate
        nickname={props.top.nickname}
        eloRate={props.top.eloRate}
        eloRank={props.top.eloRank}
        side="left"
      />
      {/* Transparent: the POV clip is composited through this in the NLE. */}
      <div className="short-pane" style={{ height: SHORT_POV_HEIGHT }} />
      <Nameplate
        nickname={props.bottom.nickname}
        eloRate={props.bottom.eloRate}
        eloRank={props.bottom.eloRank}
        side="right"
      />
      <div className="short-pane" style={{ height: SHORT_POV_HEIGHT }} />

      <div className="short-brand" style={{ height: SHORT_BRAND_BAR_HEIGHT }}>
        <PixelBadge />
        <span className="short-wordmark">MCSR Replayoffs</span>
        <span className="short-rta">at {formatShortTime(props.timerStartMs)}</span>
      </div>
    </AbsoluteFill>
  );
};

/**
 * The hook line alone, on a transparent frame, so ffmpeg can fade it out after a few seconds
 * without the board fading with it.
 *
 * Centred on the seam between the top pane and the lower nameplate, which is where the
 * best-performing Short on the competing channel (~42k views) puts its own hook. It costs four
 * seconds of the lower player's nameplate, and that is the trade: nothing else on the board is
 * asking anyone to keep watching, and a caption tucked into a corner reads as a subtitle.
 */
export const ShortHook: FC<ShortProps> = (props) => {
  const { lines, fontSize } = layoutShortHook(props.hook);
  return (
    <AbsoluteFill>
      {/* Optically centred, not box-centred: the outline reaches 7px left of the glyphs and the
          crimson drop 14px right, so a box-centred block sits ~7px right of where the eye puts
          the middle. `translate` rather than `transform`, which .short-hook already uses for its
          own vertical centring. */}
      <div className="short-hook" style={{ top: SHORT_BOTTOM_NAMEPLATE_Y, fontSize, translate: "-7px" }}>
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
