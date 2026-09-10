import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
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
 * What the vertical board carries on top of the props the dashboard's Shorts panel shares.
 *
 * Both are optional and both are absent for a good reason rather than by oversight: `headUrl`
 * needs the player's uuid, which only the render path has, and `resultMs` is set *only* when the
 * cut window actually reaches the finish — a Short that stops mid-run must not stamp a time the
 * viewer never watched happen.
 */
export type ShortBoardProps = ShortProps & {
  top: ShortProps["top"] & { headUrl?: string; seed?: string };
  bottom: ShortProps["bottom"] & { headUrl?: string; seed?: string };
  /** The run's length from the match record, never read off the board's own label. */
  resultMs?: number;
};

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
  headUrl,
  seed,
  side,
}: {
  nickname: string;
  eloRate: number;
  eloRank: number | null;
  headUrl?: string;
  /** A playoff game's seed label ("#1 seed", "LCQ"); absent on a ranked match. */
  seed?: string;
  side: "left" | "right";
}) {
  return (
    <div className={`short-plate ${side}`} style={{ height: SHORT_NAMEPLATE_HEIGHT }}>
      <PixelBadge />
      {/* The head, as the 16:9 overlay's IdentBar and the intro card both do it: every reference
          Short and the official broadcast put a face beside the name, and on a phone it is the
          only thing that tells the two panes apart at a glance. */}
      {headUrl && <Img className="player-head" src={headUrl} />}
      <div className="short-plate-text">
        <span className="short-name">{nickname}</span>
        <span className="short-elo">
          {/* On a playoff game the seed replaces the ladder rank: the rank is a ranked-ladder
              fact and a bracket has its own order, and it is the seed pair that states an upset
              without a word — the device every high-performing playoff Short in the set uses. */}
          {eloRate} ELO
          {seed !== undefined ? (
            <span className="short-seed"> {seed}</span>
          ) : (
            eloRank !== null && <span className="short-rank"> #{eloRank}</span>
          )}
        </span>
      </div>
    </div>
  );
}

/** The board itself: everything that is on screen for the whole Short. */
export const Short: FC<ShortBoardProps> = (props) => {
  return (
    <AbsoluteFill className="short">
      <Nameplate
        nickname={props.top.nickname}
        eloRate={props.top.eloRate}
        eloRank={props.top.eloRank}
        seed={props.top.seed}
        headUrl={props.top.headUrl}
        side="left"
      />
      {/* Transparent: the POV clip is composited through this in the NLE. */}
      <div className="short-pane" style={{ height: SHORT_POV_HEIGHT }} />
      <Nameplate
        nickname={props.bottom.nickname}
        eloRate={props.bottom.eloRate}
        eloRank={props.bottom.eloRank}
        seed={props.bottom.seed}
        headUrl={props.bottom.headUrl}
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

/**
 * The closing beat, on its own transparent frame so ffmpeg can fade it in over the last seconds.
 *
 * All three 30k+ reference Shorts end on one, and a time is the one result fact that never names
 * a winner — which is also why this is centred on the frame rather than sided. The reference
 * channel puts its card over the winner's pane, and that placement alone announces the result.
 *
 * Renders nothing when the window did not reach the finish; the render path skips the still
 * entirely in that case, and this keeps the composition previewable either way.
 */
export const ShortResult: FC<ShortBoardProps> = (props) => {
  if (props.resultMs === undefined) return null;
  return (
    <AbsoluteFill>
      {/* Same white-on-outline treatment as the hook (.short-hook), re-anchored to the middle of
          the board: the band between the two panes, equidistant from both. */}
      <div className="short-hook short-result">
        <div className="short-result-label">FINAL TIME</div>
        <div>{formatShortTime(props.resultMs)}</div>
      </div>
    </AbsoluteFill>
  );
};
