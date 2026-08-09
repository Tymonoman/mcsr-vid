import type { FC } from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import "./overlay.css";
import { formatTime, formatShortTime } from "./format.js";
import type { OverlayProps, PlayerIdentity, SplitRow } from "./types.js";
import { resolveSplitSide, compareSplitSides, type SplitSideState } from "./resolveSplitSide.js";
import { Intro } from "./Intro.js";
import { PixelBadge } from "./PixelBadge.js";
import { resolveAchievementIcon } from "./achievementBadges.js";

/** Up to 3 highlighted-achievement badges under a player's id-line. Unmapped
 * ids/levels are skipped entirely, per resolveAchievementIcon's contract. */
function AchievementRow({ player }: { player: PlayerIdentity }) {
  const icons = player.achievements
    .map((a) => resolveAchievementIcon(a.id, a.level))
    .filter((src): src is string => src !== null);
  if (icons.length === 0) return null;
  return (
    <div className="ach-row">
      {icons.map((src, i) => (
        <Img key={`${src}-${i}`} src={src} />
      ))}
    </div>
  );
}

function IdentBar({ props }: { props: OverlayProps }) {
  return (
    <div className="row1">
      <div className="half crimson">
        <span className="name">{props.left.nickname}</span>
      </div>
      <div className="half warped">
        <span className="name">{props.right.nickname}</span>
      </div>
    </div>
  );
}

function InfoBar({ props }: { props: OverlayProps }) {
  const { left, right } = props;
  return (
    <div className="row2">
      <div className="half left">
        <div className="id-line">
          <span className="flag">{left.countryFlag}</span>
          <span className="elo">{left.eloRate} ELO</span>
          <span className="rank">#{left.eloRank} WORLD</span>
        </div>
        <AchievementRow player={left} />
        <div className="deep-line">
          PB <b>{formatTime(left.pbMs)}</b>
          <span className="sep">·</span>
          AVG <b>{formatTime(left.avgMs)}</b>
          <span className="sep">·</span>
          <b>{left.gamesPlayed.toLocaleString()}</b> GAMES
          <span className="sep">·</span>
          <b>{left.winRatePct.toFixed(1)}%</b> WR
        </div>
      </div>
      <div className="half right">
        <div className="id-line">
          <span className="rank">#{right.eloRank} WORLD</span>
          <span className="elo">{right.eloRate} ELO</span>
          <span className="flag">{right.countryFlag}</span>
        </div>
        <AchievementRow player={right} />
        <div className="deep-line">
          WR <b>{right.winRatePct.toFixed(1)}%</b>
          <span className="sep">·</span>
          GAMES <b>{right.gamesPlayed.toLocaleString()}</b>
          <span className="sep">·</span>
          AVG <b>{formatTime(right.avgMs)}</b>
          <span className="sep">·</span>
          PB <b>{formatTime(right.pbMs)}</b>
        </div>
      </div>
    </div>
  );
}

function SplitSideView({
  state,
  side,
  isLeading,
  deltaMs,
}: {
  state: SplitSideState;
  side: "left" | "right";
  isLeading: boolean;
  deltaMs: number | null;
}) {
  if (state.kind === "pending") return <span className={`t ${side}`} />;
  if (state.kind === "dnf") return <span className={`t ${side} dnf`}>—</span>;
  return (
    <span className={`t ${side} ${isLeading ? "lead" : "behind"}`}>
      {formatShortTime(state.ms)}
      {!isLeading && deltaMs !== null && <span className="delta">+{formatShortTime(deltaMs)}</span>}
    </span>
  );
}

function SplitRowView({
  row,
  frame,
  fps,
  timerStartFrame,
  runEndFrame,
}: {
  row: SplitRow;
  frame: number;
  fps: number;
  timerStartFrame: number;
  runEndFrame: number;
}) {
  const left = resolveSplitSide(row.leftMs, timerStartFrame, fps, runEndFrame, frame);
  const right = resolveSplitSide(row.rightMs, timerStartFrame, fps, runEndFrame, frame);
  const { leftLeads, deltaMs } = compareSplitSides(left, right);

  return (
    <div className="split-row">
      <SplitSideView state={left} side="left" isLeading={leftLeads} deltaMs={deltaMs} />
      <span className="name">{row.label}</span>
      <SplitSideView state={right} side="right" isLeading={!leftLeads} deltaMs={deltaMs} />
    </div>
  );
}

function SplitsPanel({
  props,
  elapsedMs,
  frame,
  fps,
  runEndFrame,
}: {
  props: OverlayProps;
  elapsedMs: number;
  frame: number;
  fps: number;
  runEndFrame: number;
}) {
  return (
    <div className="splits">
      <div className="splits-col col-meta">
        <span className="label">Match Played</span>
        <span className="value">{props.matchPlayedLabel}</span>
        <span className="h2h-label">Head-to-Head (Ranked)</span>
        <span className="h2h-value">
          <span className="l">
            {props.left.nickname} {props.h2hLeftWins}
          </span>
          <span className="sep"> — </span>
          <span className="r">
            {props.h2hRightWins} {props.right.nickname}
          </span>
        </span>
      </div>
      <div className="splits-col col-splits">
        <div className="splits-title">Match Splits</div>
        <div className="split-table">
          {props.splits.map((row) => (
            <SplitRowView
              key={row.label}
              row={row}
              frame={frame}
              fps={fps}
              timerStartFrame={props.timerStartFrame}
              runEndFrame={runEndFrame}
            />
          ))}
        </div>
      </div>
      <div className="splits-col col-rta">
        <span className="label">RTA</span>
        <div className="live">
          <span className="dot" />
          <span className="value">{formatTime(elapsedMs)}</span>
        </div>
      </div>
    </div>
  );
}

export const Overlay: FC<OverlayProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rawElapsedMs = Math.max(0, ((frame - props.timerStartFrame) / fps) * 1000);
  const elapsedMs =
    props.runResultMs !== null ? Math.min(rawElapsedMs, props.runResultMs) : rawElapsedMs;
  const runEndFrame =
    props.runResultMs !== null
      ? props.timerStartFrame + (props.runResultMs / 1000) * fps
      : props.durationInFrames;

  return (
    <AbsoluteFill>
      <IdentBar props={props} />
      <PixelBadge />
      <InfoBar props={props} />
      <SplitsPanel props={props} elapsedMs={elapsedMs} frame={frame} fps={fps} runEndFrame={runEndFrame} />
      <Intro props={props} />
    </AbsoluteFill>
  );
};
