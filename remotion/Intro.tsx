import type { FC } from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { formatConstantLabel, formatTime } from "./format.js";
import type { OverlayProps, PlayerIdentity } from "./types.js";

import { INTRO_SECONDS } from "./layout.js";

function PlayerCard({
  player,
  side,
  frame,
  fps,
}: {
  player: PlayerIdentity;
  side: "left" | "right";
  frame: number;
  fps: number;
}) {
  const sign = side === "left" ? -1 : 1;
  const entranceX = interpolate(frame, [fps * 0.15, fps * 0.55], [sign * -1400, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const statsOpacity = interpolate(frame, [fps * 0.7, fps * 1.05], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const statsY = interpolate(frame, [fps * 0.7, fps * 1.05], [24, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div className={`intro-player ${side}`} style={{ transform: `translateX(${entranceX}px)` }}>
      <div className="intro-avatar">
        <Img src={player.avatarUrl} />
      </div>
      <div className="intro-info">
        <span className="intro-name">{player.nickname}</span>
        <span className="intro-id-line">
          <span className="flag">{player.countryFlag}</span>
          <span className="elo">{player.eloRate} ELO</span>
          <span className="rank">#{player.eloRank} WORLD</span>
        </span>
        <div className="intro-stats" style={{ opacity: statsOpacity, transform: `translateY(${statsY}px)` }}>
          <span>
            PB <b>{formatTime(player.pbMs)}</b>
          </span>
          <span>
            AVG <b>{formatTime(player.avgMs)}</b>
          </span>
          <span>
            <b>{player.gamesPlayed.toLocaleString()}</b> GAMES
          </span>
          <span>
            <b>{player.winRatePct.toFixed(1)}%</b> WR
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The centre column under the VS badge: the head-to-head record, and what the seed is.
 *
 * Both long-form competitors open on a head-to-head table, and both then fill the ten-second
 * ready-countdown with a "Seed Type: Village" card. This channel's intro *is* that window — it
 * runs 0-7s of the countdown — so the seed rides along on the versus card instead of costing a
 * second element. `formatConstantLabel` is the same humaniser the bottom band's seed chip uses,
 * so the two can't disagree about what a bastion is called; CSS uppercases it for the label.
 */
function VersusRecord({ props, opacity }: { props: OverlayProps; opacity: number }) {
  const left = props.h2hLeftWins;
  const right = props.h2hRightWins;
  const seed = [
    props.seedType && `${formatConstantLabel(props.seedType)} Seed`,
    props.bastionType && `${formatConstantLabel(props.bastionType)} Bastion`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="intro-h2h" style={{ opacity }}>
      <span className="intro-h2h-label">Head to Head</span>
      {left === 0 && right === 0 ? (
        // "0 – 0" reads as a scoreline someone forgot to fill in; say what it means instead.
        <span className="intro-h2h-first">First Meeting</span>
      ) : (
        <span className="intro-h2h-record">
          <b className={left > right ? "l" : ""}>{left}</b>
          <span className="dash">–</span>
          <b className={right > left ? "r" : ""}>{right}</b>
        </span>
      )}
      {seed && <span className="intro-h2h-seed">{seed}</span>}
    </div>
  );
}

/** Full-screen versus card for the video's first INTRO_SECONDS, opaque so it covers the
 *  gameplay track underneath, then wipes to transparent to reveal it. */
export const Intro: FC<{ props: OverlayProps }> = ({ props }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const introFrames = Math.round(fps * INTRO_SECONDS);
  const exitStart = introFrames - Math.round(fps * 0.6);

  if (frame >= introFrames) return null;

  const opacity = interpolate(frame, [0, fps * 0.25, exitStart, introFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const badgeScale = interpolate(frame, [fps * 0.3, fps * 0.7, exitStart, introFrames], [0.4, 1, 1, 1.25], {
    easing: Easing.out(Easing.back(1.6)),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // The same window PlayerCard fades its stats in on: everything that isn't the headline
  // (names, VS badge) arrives together, one beat after the cards land.
  const detailOpacity = interpolate(frame, [fps * 0.7, fps * 1.05], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill className="intro" style={{ opacity }}>
      <PlayerCard player={props.left} side="left" frame={frame} fps={fps} />
      <PlayerCard player={props.right} side="right" frame={frame} fps={fps} />
      <div className="intro-vs" style={{ transform: `scale(${badgeScale})` }}>
        <span className="intro-vs-text">VS</span>
      </div>
      <VersusRecord props={props} opacity={detailOpacity} />
      <div className="intro-meta">{props.matchPlayedLabel}</div>
    </AbsoluteFill>
  );
};
