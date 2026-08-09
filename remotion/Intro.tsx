import type { FC } from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { formatTime } from "./format.js";
import type { OverlayProps, PlayerIdentity } from "./types.js";

import { INTRO_SECONDS } from "./layout.js";

export { INTRO_SECONDS };

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

  return (
    <AbsoluteFill className="intro" style={{ opacity }}>
      <PlayerCard player={props.left} side="left" frame={frame} fps={fps} />
      <PlayerCard player={props.right} side="right" frame={frame} fps={fps} />
      <div className="intro-vs" style={{ transform: `scale(${badgeScale})` }}>
        <span className="intro-vs-text">VS</span>
      </div>
      <div className="intro-meta">{props.matchPlayedLabel}</div>
    </AbsoluteFill>
  );
};
