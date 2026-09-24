import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
import "./overlay.css";
import type { ThumbnailProps, ThumbnailPlayer } from "./types.js";
import { PixelBadge } from "./PixelBadge.js";

/** Padding above and below the wordmark inside the trophy band. */
const BAND_PAD = 12;
/** How far the avatars are allowed to run up behind the band's lower edge. */
const BAND_OVERLAP = 40;

function PlayerRender({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-player ${side}`}>
      <Img src={player.avatarUrl} />
    </div>
  );
}

/** The nameplate: the rating, or on a playoff the seed — a bracket has its own order. */
function PlayerTag({
  player,
  side,
  seed,
}: {
  player: ThumbnailPlayer;
  side: "left" | "right";
  seed?: string;
}) {
  return (
    <div className={`thumb-tag ${side}`}>
      {seed !== undefined ? (
        <span className="elo seed">{seed}</span>
      ) : (
        <span className="elo">[{player.eloRate}]</span>
      )}
      <span className="nick">{player.nickname}</span>
    </div>
  );
}

/** The trophy band: PLAYOFFS as the wordmark, the round under it. */
const TROPHY_BAND_HEIGHT = BAND_PAD * 2 + Math.round(96 * 1.04) + 44;

export const Thumbnail: FC<ThumbnailProps> = (props) => {
  const playoff = props.playoff;
  const trophy = playoff?.style === "trophy";
  const layout = trophy
    ? { bandHeight: TROPHY_BAND_HEIGHT, bodyTop: TROPHY_BAND_HEIGHT - BAND_OVERLAP }
    : null;
  const roundLabel = playoff ? `Season ${playoff.season} Playoffs · ${playoff.round}` : null;

  return (
    <AbsoluteFill className={`thumb${playoff ? ` playoff ${playoff.style}` : ""}`}>
      <div
        className={`thumb-header${trophy ? " trophy" : ""}`}
        style={layout ? { height: layout.bandHeight } : undefined}
      >
        {trophy ? (
          <div className="thumb-trophy">
            <div className="thumb-hook wordmark" style={{ fontSize: 96 }}>
              Playoffs
            </div>
            <span className="label round">{`Season ${playoff!.season} · ${playoff!.round}`}</span>
          </div>
        ) : (
          <span className={`label${playoff ? " round" : ""}`}>{roundLabel ?? props.headerLabel}</span>
        )}
      </div>
      {/* The body is pushed down by the band it would otherwise be hidden behind: everything
          inside it (avatars, VS, nameplates, badge) is positioned against the body, so one
          offset moves the whole face-off rather than four. */}
      <div className="thumb-body" style={layout ? { top: layout.bodyTop } : undefined}>
        <PlayerRender player={props.left} side="left" />
        <PlayerRender player={props.right} side="right" />
        <span className="thumb-vs">VS</span>
        {playoff && <span className="thumb-bestof">Best of {playoff.bestOf}</span>}
        <PlayerTag player={props.left} side="left" seed={playoff?.leftSeed} />
        <PlayerTag player={props.right} side="right" seed={playoff?.rightSeed} />
        <div className="thumb-logo">
          <PixelBadge />
        </div>
      </div>
    </AbsoluteFill>
  );
};
