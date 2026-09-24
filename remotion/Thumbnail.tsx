import type { FC } from "react";
import { AbsoluteFill, Img } from "remotion";
import "./overlay.css";
import type { ThumbnailProps, ThumbnailPlayer } from "./types.js";
import { PixelBadge } from "./PixelBadge.js";

/** Padding above and below the wordmark inside the trophy band. */
const BAND_PAD = 12;
/** The plain band's height, its 4 px rule included (`.thumb-header` in overlay.source.css). */
const HEADER_HEIGHT = 68;

/** The seed types the centre slot has art for; any other value leaves the slot out. */
const SEED_TYPES = new Set(["VILLAGE", "SHIPWRECK", "DESERT_TEMPLE", "RUINED_PORTAL", "BURIED_TREASURE"]);

/**
 * Draws nothing: the seed-type art is being drawn on branch agy/seed-icons
 * (remotion/SeedIcon.tsx, `SeedIcon({ type, size })`). The merge replaces this with that import.
 */
const SeedIconPlaceholder: FC<{ type: string | null; size: number }> = () => null;

/** The name's size: 56 px, shrunk so a 16-character name fits the plate (Monocraft's advance is 0.66 em). */
const nickFontPx = (nickname: string) => Math.min(56, Math.floor(520 / (0.66 * nickname.length)));

function PlayerRender({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-player ${side}`}>
      <Img src={player.avatarUrl} />
    </div>
  );
}

/** The nameplate: the name only. No rating (it changes daily) and no seed, on a playoff too. */
function PlayerTag({ player, side }: { player: ThumbnailPlayer; side: "left" | "right" }) {
  return (
    <div className={`thumb-tag ${side}`}>
      <span className="nick" style={{ fontSize: nickFontPx(player.nickname) }}>
        {player.nickname}
      </span>
    </div>
  );
}

/** The trophy band: PLAYOFFS as the wordmark, the round under it. */
const TROPHY_BAND_HEIGHT = BAND_PAD * 2 + Math.round(96 * 1.04) + 44;

export const Thumbnail: FC<ThumbnailProps> = (props) => {
  const playoff = props.playoff;
  const trophy = playoff?.style === "trophy";
  const layout = trophy
    ? { bandHeight: TROPHY_BAND_HEIGHT, bodyTop: TROPHY_BAND_HEIGHT - HEADER_HEIGHT }
    : null;
  const label = playoff ? `Season ${playoff.season} Playoffs · ${playoff.round}` : props.headerLabel;
  const seedType = props.seedType && SEED_TYPES.has(props.seedType) ? props.seedType : null;

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
            {/* The series length rides in the band here: under the VS it would meet the plates
                once the body is pushed down by the taller band. */}
            <span className="label round">{`Season ${playoff!.season} · ${playoff!.round} · Best of ${playoff!.bestOf}`}</span>
          </div>
        ) : (
          label.split("·").map((word, i) => (
            <span key={i} className={`label${playoff ? " round" : ""}`}>
              {word.trim()}
            </span>
          ))
        )}
      </div>
      {/* The body is pushed down by the band it would otherwise be hidden behind: everything
          positioned from its top (avatars, seed slot, VS) moves with one offset. The plates and
          the badge sit from the bottom, so a taller band never pushes a plate under YouTube's
          duration stamp. */}
      <div className="thumb-body" style={layout ? { top: layout.bodyTop } : undefined}>
        <PlayerRender player={props.left} side="left" />
        <PlayerRender player={props.right} side="right" />
        {seedType && (
          <div className="thumb-seed">
            <SeedIconPlaceholder type={seedType} size={132} />
          </div>
        )}
        <span className="thumb-vs">VS</span>
        {playoff && !trophy && <span className="thumb-bestof">Best of {playoff.bestOf}</span>}
        <PlayerTag player={props.left} side="left" />
        <PlayerTag player={props.right} side="right" />
        <div className="thumb-logo">
          <PixelBadge />
        </div>
      </div>
    </AbsoluteFill>
  );
};
