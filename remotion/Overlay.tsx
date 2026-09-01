import type { FC, ReactNode } from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import "./overlay.css";
import { formatTime, formatShortTime, formatConstantLabel } from "./format.js";
import type { OverlayProps, PlayerIdentity, SplitRow } from "./types.js";
import { resolveSplitSide, compareSplitSides, type SplitSideState } from "./resolveSplitSide.js";
import { Intro } from "./Intro.js";
import { PixelBadge } from "./PixelBadge.js";
import { BastionIcon } from "./BastionIcon.js";
import { STAGE_WIDTH, STAGE_HEIGHT, BOTTOM_BAND_Y } from "./layout.js";
import { resolveAchievementIcon } from "./achievementBadges.js";

/** Up to 3 highlighted-achievement badges for one player, shown in the splits panel.
 * Unmapped ids/levels are skipped entirely, per resolveAchievementIcon's contract. */
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
        <Img className="player-head" src={props.left.headUrl} />
        <span className="name">{props.left.nickname}</span>
      </div>
      <div className="half warped">
        <span className="name">{props.right.nickname}</span>
        <Img className="player-head" src={props.right.headUrl} />
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
          {left.eloRank !== null && <span className="rank">#{left.eloRank} WORLD</span>}
        </div>
        <div className="deep-line">
          PB <b>{formatTime(left.pbMs)}</b>
          <span className="sep">·</span>
          {/* Scopes everything after it. PB sits outside deliberately — it's always lifetime. */}
          <span className="scope">{left.statsScope}</span>
          AVG <b>{formatTime(left.avgMs)}</b>
          <span className="sep">·</span>
          <b>{left.gamesPlayed.toLocaleString()}</b> GAMES
          <span className="sep">·</span>
          <b>{left.winRatePct.toFixed(1)}%</b> WR
          <span className="sep">·</span>
          <b>{left.forfeitRatePct.toFixed(1)}%</b> FF
        </div>
      </div>
      <div className="half right">
        <div className="id-line">
          {right.eloRank !== null && <span className="rank">#{right.eloRank} WORLD</span>}
          <span className="elo">{right.eloRate} ELO</span>
          <span className="flag">{right.countryFlag}</span>
        </div>
        <div className="deep-line">
          FF <b>{right.forfeitRatePct.toFixed(1)}%</b>
          <span className="sep">·</span>
          WR <b>{right.winRatePct.toFixed(1)}%</b>
          <span className="sep">·</span>
          GAMES <b>{right.gamesPlayed.toLocaleString()}</b>
          <span className="sep">·</span>
          AVG <b>{formatTime(right.avgMs)}</b>
          <span className="scope">{right.statsScope}</span>
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
        <span className="seed-chip">
          <BastionIcon bastionType={props.bastionType} />
          <span className="seed-label">
            {formatConstantLabel(props.seedType)} · {formatConstantLabel(props.bastionType)}
          </span>
        </span>
        <span className="h2h-label">Head-to-Head (Season)</span>
        <span className="h2h-value">
          <span className="l">
            {props.left.nickname} {props.h2hLeftWins}
          </span>
          <span className="sep"> — </span>
          <span className="r">
            {props.h2hRightWins} {props.right.nickname}
          </span>
        </span>
        <span className="ach-label">Achievements</span>
        <div className="ach-cols">
          <AchievementRow player={props.left} />
          <AchievementRow player={props.right} />
        </div>
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

function useTimer(props: OverlayProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rawElapsedMs = Math.max(0, ((frame - props.timerStartFrame) / fps) * 1000);
  const elapsedMs =
    props.runResultMs !== null ? Math.min(rawElapsedMs, props.runResultMs) : rawElapsedMs;
  const runEndFrame =
    props.runResultMs !== null
      ? props.timerStartFrame + (props.runResultMs / 1000) * fps
      : props.durationInFrames;
  return { frame, fps, elapsedMs, runEndFrame };
}

export const Overlay: FC<OverlayProps> = (props) => {
  const { frame, fps, elapsedMs, runEndFrame } = useTimer(props);

  return (
    <AbsoluteFill>
      <IdentBar props={props} />
      <InfoBar props={props} />
      <SplitsPanel props={props} elapsedMs={elapsedMs} frame={frame} fps={fps} runEndFrame={runEndFrame} />
      {/* Painted after InfoBar so it's never occluded by InfoBar's background —
          the badge (173px) is taller than IdentBar (9% of frame height) and
          overlaps into InfoBar's box. Intro still needs to paint after this:
          it's a temporary full-screen cover for the first few seconds. */}
      <PixelBadge />
      <Intro props={props} />
    </AbsoluteFill>
  );
};

// The overlay's content only occupies a band at the top and a band at the bottom; the ~524px
// between them is transparent, and rendering it cost ~half of every frame. These split the
// same layout into separately-rendered strips (see src/overlayRender.ts).
export { TOP_BAND_HEIGHT, BOTTOM_BAND_HEIGHT, BOTTOM_BAND_Y } from "./layout.js";

/**
 * Renders the full-size 1920x1080 stage inside a shorter canvas, shifted up so only the wanted
 * band shows. The stage keeps its real dimensions, so every percentage-based rule in
 * overlay.source.css resolves exactly as it does full-frame — the strips are pixel-identical
 * to the corresponding region of the full overlay rather than a re-laid-out approximation.
 */
function Band({ offsetY, children }: { offsetY: number; children: ReactNode }) {
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: -offsetY,
          left: 0,
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** Static for the whole match — rendered once as a still, not as video. */
export const OverlayTop: FC<OverlayProps> = (props) => (
  <Band offsetY={0}>
    <IdentBar props={props} />
    <InfoBar props={props} />
    {/* Painted after InfoBar so it's never occluded by InfoBar's background —
        the badge (173px) is taller than IdentBar (9% of frame height) and
        overlaps into InfoBar's box. Same fix as the unbanded Overlay export
        above; this is the composition actually used by the real render
        pipeline (src/overlayRender.ts), so it needs it too. */}
    <PixelBadge />
  </Band>
);

/** The only part that actually animates: the RTA timer and the splits revealing. */
export const OverlayBottom: FC<OverlayProps> = (props) => {
  const { frame, fps, elapsedMs, runEndFrame } = useTimer(props);
  return (
    <Band offsetY={BOTTOM_BAND_Y}>
      <SplitsPanel props={props} elapsedMs={elapsedMs} frame={frame} fps={fps} runEndFrame={runEndFrame} />
    </Band>
  );
};

/** Full-frame and opaque, so it stays its own short clip laid over the strips. */
export const OverlayIntro: FC<OverlayProps> = (props) => (
  <AbsoluteFill>
    <Intro props={props} />
  </AbsoluteFill>
);
