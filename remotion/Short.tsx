import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
import "./overlay.css";
import { formatShortTime } from "./format.js";
import { PixelBadge } from "./PixelBadge.js";
import type { ShortProps } from "./types.js";
import type { ShortCaption as ShortCaptionData } from "../src/shorts/shortPlan.js";
import { layoutShortHook } from "./shortHookLayout.js";
import {
  SHORT_BOTTOM_NAMEPLATE_Y,
  SHORT_BRAND_BAR_HEIGHT,
  SHORT_CAPTION_HEIGHT,
  SHORT_COMPACT_NAMEPLATE_HEIGHT,
  SHORT_NAMEPLATE_HEIGHT,
  SHORT_POV_HEIGHT,
  SHORT_SOLO_POV_Y,
  SHORT_SOLO_POV_HEIGHT,
  shortCaptionFontSize,
  shortCaptionY,
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
 * What one still needs besides the players, set by the render path (shortRender.ts) rather than
 * by its callers. Every field is optional, and absent means the board as it was before 23 Sept
 * 2026: both POVs, the static "at m:ss" label, no caption strip.
 */
export type ShortStillProps = ShortBoardProps & {
  /** Both POVs stacked, or one player's alone (`left` is `top`, `right` is `bottom`). */
  pov?: "both" | "left" | "right";
  /** The bar leaves its right-hand side to ffmpeg's running clock instead of printing "at m:ss". */
  clock?: boolean;
  /** Both POVs only: reserve the caption strip under the top pane (one POV always has it). */
  captionStrip?: boolean;
  /** The caption the ShortCaption still draws. */
  caption?: Pick<ShortCaptionData, "text" | "side">;
  /** The line the ShortEndCard still draws, e.g. "Who took it? Full match on the channel". */
  endCard?: string;
};

/**
 * The 1080x1920 Shorts board: a nameplate above each POV pane, and a channel bar pinned to the
 * bottom. The two gameplay panes are transparent holes the POV clips show through.
 *
 * Rendered as *stills*, not video, for the same reason the 16:9 overlay is: nothing here moves,
 * and ffmpeg switches the hook, the captions and the closing card on and off by itself. The one
 * thing that does move — the running race clock in the bar — is drawn by ffmpeg too (drawtext,
 * Monocraft), so it costs no Remotion frames; with `clock` off the bar keeps the static "at m:ss"
 * label instead.
 *
 * With one POV (`pov: "left" | "right"`) the board is that player's nameplate, the caption strip
 * naming the opponent, one tall pane and the bar.
 */

function Nameplate({
  nickname,
  eloRate,
  eloRank,
  headUrl,
  seed,
  side,
  variant,
}: {
  nickname: string;
  eloRate: number;
  eloRank: number | null;
  headUrl?: string;
  /** A playoff game's seed label ("#1 seed", "LCQ"); absent on a ranked match. */
  seed?: string;
  side: "left" | "right";
  /**
   * `compact`: the lower plate under the caption strip, in what the strip leaves of it. `solo`:
   * the only plate on a one-POV board, flush left whichever side it is — mirrored only reads as
   * mirrored with the other plate there.
   */
  variant?: "compact" | "solo";
}) {
  return (
    <div
      className={`short-plate ${side}${variant ? ` ${variant}` : ""}`}
      style={{ height: variant === "compact" ? SHORT_COMPACT_NAMEPLATE_HEIGHT : SHORT_NAMEPLATE_HEIGHT }}
    >
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

const plateOf = (player: ShortBoardProps["top"], side: "left" | "right", variant?: "compact" | "solo") => (
  <Nameplate
    nickname={player.nickname}
    eloRate={player.eloRate}
    eloRank={player.eloRank}
    seed={player.seed}
    headUrl={player.headUrl}
    side={side}
    variant={variant}
  />
);

/**
 * The channel bar. With `clock` it is laid out flush left and leaves its right-hand side empty:
 * ffmpeg draws the running race clock there (shortRender.ts) in the same font.
 */
function BrandBar({ timerStartMs, clock }: { timerStartMs: number; clock: boolean }) {
  return (
    <div className={`short-brand${clock ? " clocked" : ""}`} style={{ height: SHORT_BRAND_BAR_HEIGHT }}>
      <PixelBadge />
      <span className="short-wordmark">MCSR Replayoffs</span>
      {!clock && <span className="short-rta">at {formatShortTime(timerStartMs)}</span>}
    </div>
  );
}

/** The board itself: everything that is on screen for the whole Short. */
export const Short: FC<ShortStillProps> = (props) => {
  const pov = props.pov ?? "both";
  const bar = <BrandBar timerStartMs={props.timerStartMs} clock={props.clock ?? false} />;
  if (pov !== "both") {
    // One player's POV alone. The strip under the plate names the opponent, so a Short of one
    // player's death still reads as a race; the captions cover it from the hook's end on.
    const [shown, other] = pov === "left" ? [props.top, props.bottom] : [props.bottom, props.top];
    return (
      <AbsoluteFill className="short">
        {plateOf(shown, pov, "solo")}
        <div className="short-strip" style={{ height: SHORT_CAPTION_HEIGHT }}>
          <span className={`short-vs ${pov === "left" ? "right" : "left"}`}>vs {other.nickname}</span>
        </div>
        <div className="short-pane" style={{ height: SHORT_SOLO_POV_HEIGHT }} />
        {bar}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill className="short">
      {plateOf(props.top, "left")}
      {/* Transparent: the POV clip is composited through this in the NLE. */}
      <div className="short-pane" style={{ height: SHORT_POV_HEIGHT }} />
      {props.captionStrip && <div className="short-strip" style={{ height: SHORT_CAPTION_HEIGHT }} />}
      {plateOf(props.bottom, "right", props.captionStrip ? "compact" : undefined)}
      <div className="short-pane" style={{ height: SHORT_POV_HEIGHT }} />
      {bar}
    </AbsoluteFill>
  );
};

/**
 * The hook line alone, on a transparent frame, so ffmpeg can take it off after SHORT_HOOK_SEC
 * without the board going with it.
 *
 * With both POVs it is centred on the seam between the top pane and the lower nameplate, which
 * is where the best-performing Short on the competing channel (~42k views) puts its own hook. It
 * costs four seconds of the lower player's nameplate, and that is the trade: nothing else on the
 * board is asking anyone to keep watching, and a caption tucked into a corner reads as a
 * subtitle. The first caption then lands in the strip right under that seam. With one POV the
 * hook hangs just under the caption strip instead, over the sky end of the picture: the
 * crosshair stays clear, the strip's "vs" line does not show through the letters, and the first
 * caption lands directly above where the hook's first line was.
 */
export const ShortHook: FC<ShortStillProps> = (props) => {
  const { lines, fontSize } = layoutShortHook(props.hook);
  const solo = (props.pov ?? "both") !== "both";
  return (
    <AbsoluteFill>
      {/* Optically centred, not box-centred: the outline reaches 7px left of the glyphs and the
          crimson drop 14px right, so a box-centred block sits ~7px right of where the eye puts
          the middle. `translate` rather than `transform`, which .short-hook already uses for its
          own vertical centring. */}
      <div
        className={`short-hook${solo ? " solo" : ""}`}
        style={{
          top: solo ? SHORT_SOLO_POV_Y + 24 : SHORT_BOTTOM_NAMEPLATE_Y,
          fontSize,
          translate: "-7px",
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/**
 * One data caption, on a transparent frame: an opaque strip exactly over the board's caption
 * strip, so a caption replaces the one before it (or the hook, or the "vs" line) outright. The
 * colour says whose line it is; the words are the caption writer's (shortPlan.ts), and never
 * name a winner.
 */
export const ShortCaption: FC<ShortStillProps> = (props) => {
  if (!props.caption) return null;
  return (
    <AbsoluteFill>
      <div
        className={`short-strip short-caption ${props.caption.side ?? "neutral"}`}
        style={{
          top: shortCaptionY(props.pov ?? "both"),
          height: SHORT_CAPTION_HEIGHT,
          fontSize: shortCaptionFontSize(props.caption.text),
        }}
      >
        {props.caption.text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * "Who took it? Full match on the channel" as a headline and a gold line under it: the first
 * sentence is the headline and the rest the line; an explicit newline splits it instead.
 */
export function splitEndCard(text: string): { headline: string; sub: string } {
  const nl = text.indexOf("\n");
  if (nl >= 0) return { headline: text.slice(0, nl).trim(), sub: text.slice(nl + 1).trim() };
  const m = text.trim().match(/^(.+?[?!.])\s+(.+)$/s);
  return m ? { headline: m[1]!, sub: m[2]! } : { headline: text.trim(), sub: "" };
}

/**
 * The closing card that replaces FINAL TIME (`endCard`): the result card's slab and outline
 * carrying a question instead of a number, so the last frame asks rather than tells. Centred on
 * the board for the same reason the result card is.
 */
export const ShortEndCard: FC<ShortStillProps> = (props) => {
  if (!props.endCard) return null;
  const { headline, sub } = splitEndCard(props.endCard);
  const { lines, fontSize } = layoutShortHook(headline);
  return (
    <AbsoluteFill>
      <div className="short-hook short-result short-endcard">
        <div style={{ fontSize }}>
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        {sub && <div className="short-endcard-sub">{sub}</div>}
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
 * entirely in that case, and this keeps the composition previewable either way. Superseded by
 * ShortEndCard whenever the render is given an `endCard`.
 */
export const ShortResult: FC<ShortStillProps> = (props) => {
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
