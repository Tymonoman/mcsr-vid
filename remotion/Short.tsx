import type { FC } from "react";
import { AbsoluteFill } from "remotion";
import "./overlay.css";
import { formatShortTime } from "./format.js";
import { PixelBadge } from "./PixelBadge.js";
import type { ShortProps } from "./types.js";
import {
  SHORT_BRAND_BAR_HEIGHT,
  SHORT_HOOK_SEC,
  SHORT_NAMEPLATE_HEIGHT,
  SHORT_POV_HEIGHT,
} from "./layout.js";

/**
 * The hook sits just above the lower nameplate: inside the top pane, over gameplay. Derived
 * from the band heights rather than a percentage so it tracks the layout, and expressed as a
 * distance from the bottom because that is what the bands below it add up to.
 */
const HOOK_BOTTOM_PX = SHORT_POV_HEIGHT + SHORT_NAMEPLATE_HEIGHT + SHORT_BRAND_BAR_HEIGHT + 28;

/**
 * The 1080x1920 Shorts board: a nameplate above each POV pane, and a channel bar pinned to the
 * bottom. The two gameplay panes are transparent holes the POV clips show through.
 *
 * Rendered as two *stills*, not video, for the same reason the 16:9 overlay is: nothing here
 * moves. As a 900-frame VP9 render this took about ten minutes to produce thirty seconds of
 * furniture; as two PNGs it takes a couple of seconds, and ffmpeg fades the hook out on its own.
 * The one thing that would genuinely animate — a live RTA counter — is deliberately a static
 * "at 6:42" label instead: neither reference channel runs a timer on their Shorts, and it is
 * not worth reintroducing a per-frame render for.
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
 * without the board fading with it. Sits just above the lower nameplate — inside the top pane,
 * over gameplay, where a caption costs neither player anything.
 */
export const ShortHook: FC<ShortProps> = (props) => (
  <AbsoluteFill>
    <div className="short-hook" style={{ bottom: HOOK_BOTTOM_PX }}>
      {props.hook}
    </div>
  </AbsoluteFill>
);

export { SHORT_HOOK_SEC };
