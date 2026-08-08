import type { FC } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import "./overlay.css";
import { formatTime } from "./format.js";
import type { OverlayProps, SplitRow } from "./types.js";

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

function Badge() {
  return (
    <div className="badge">
      <svg viewBox="0 0 100 100">
        <polygon points="50,4 96,50 50,96" fill="#e2483f" />
        <polygon points="50,4 4,50 50,96" fill="#35d6c4" />
        <rect x="46" y="0" width="8" height="100" fill="#0d0c10" />
      </svg>
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

function splitShortTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function SplitRowView({ row }: { row: SplitRow }) {
  const { leftMs, rightMs } = row;
  if (leftMs === null && rightMs === null) {
    return (
      <div className="split-row">
        <span className="t left dnf">—</span>
        <span className="name">{row.label}</span>
        <span className="t right dnf">—</span>
      </div>
    );
  }
  const leftLeads = rightMs === null || (leftMs !== null && leftMs <= rightMs);
  const deltaMs = leftMs !== null && rightMs !== null ? Math.abs(leftMs - rightMs) : null;

  return (
    <div className="split-row">
      <span className={`t left ${leftMs === null ? "dnf" : leftLeads ? "lead" : "behind"}`}>
        {leftMs === null ? "—" : splitShortTime(leftMs)}
        {leftMs !== null && !leftLeads && deltaMs !== null && (
          <span className="delta">+{splitShortTime(deltaMs)}</span>
        )}
      </span>
      <span className="name">{row.label}</span>
      <span className={`t right ${rightMs === null ? "dnf" : !leftLeads ? "lead" : "behind"}`}>
        {rightMs === null ? "—" : splitShortTime(rightMs)}
        {rightMs !== null && leftLeads && deltaMs !== null && (
          <span className="delta">+{splitShortTime(deltaMs)}</span>
        )}
      </span>
    </div>
  );
}

function SplitsPanel({ props, elapsedMs }: { props: OverlayProps; elapsedMs: number }) {
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
            <SplitRowView key={row.label} row={row} />
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

  return (
    <AbsoluteFill>
      <IdentBar props={props} />
      <Badge />
      <InfoBar props={props} />
      <SplitsPanel props={props} elapsedMs={elapsedMs} />
    </AbsoluteFill>
  );
};
