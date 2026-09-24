import type { FC } from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { formatConstantLabel, formatTime } from "./format.js";
import { introFrameCount } from "./layout.js";
import type { OverlayProps, PlayerIdentity } from "./types.js";

/*
 * The intro card: a fighting-game versus screen. The frame splits on a gold diagonal into the two
 * players' colours, each half a giant figure cut at the waist, the name, the elo/rank line and a
 * 2x2 stat block; the halves slide in from their edges and part like doors on the way out, so the
 * countdown shows through the gap. The operator's pick of three layouts, 24 Sept 2026 ("change it
 * up think of another layout"). Every animated element takes its transform inline and its
 * position from left/top in the CSS (`.iv-vs-*`, remotion/overlay.source.css), never a CSS
 * transform — an inline transform replaces the whole CSS one.
 */

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const easeOut = Easing.out(Easing.cubic);

function useClock(props: OverlayProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const total = introFrameCount(fps, props.introSec);
  const exitStart = total - Math.round(fps * 0.6);
  /** 0 → 1 between seconds a and b. */
  const t = (a: number, b: number, easing: (n: number) => number = easeOut) =>
    interpolate(frame, [fps * a, fps * b], [0, 1], { easing, ...clamp });
  const exit = interpolate(frame, [exitStart, total], [0, 1], { easing: Easing.in(Easing.cubic), ...clamp });
  return { frame, total, t, exit };
}

const seedLine = (p: OverlayProps) =>
  [
    p.seedType && `${formatConstantLabel(p.seedType)} Seed`,
    p.bastionType && `${formatConstantLabel(p.bastionType)} Bastion`,
  ]
    .filter(Boolean)
    .join(" · ");

/** The seed label in a playoff game, else the world rank; null when neither is known. */
const rankText = (pl: PlayerIdentity) => pl.seed ?? (pl.eloRank != null ? `#${pl.eloRank} WORLD` : null);

/** Monocraft's advance is ~0.67 em (measured off a render): the largest size up to `max` that keeps `name` inside `width`. */
const fitPx = (name: string, max: number, width: number) =>
  Math.min(max, Math.floor(width / (Math.max(name.length, 1) * 0.68)));

/** The lifetime head-to-head; 0–0 says "first meeting". A playoff game shows none (it would read as the series score). */
function H2H({ p }: { p: OverlayProps }) {
  const { h2hLeftWins: l, h2hRightWins: r } = p;
  return (
    <div className="iv-vs-h2h">
      <span className="lbl">Head to head</span>
      {l === 0 && r === 0 ? (
        <span className="first">First meeting</span>
      ) : (
        <span className="rec">
          <b className={l > r ? "l" : ""}>{l}</b>
          <span className="dash">–</span>
          <b className={r > l ? "r" : ""}>{r}</b>
        </span>
      )}
    </div>
  );
}

function VersusSide({
  pl,
  side,
  t,
  exit,
}: {
  pl: PlayerIdentity;
  side: "left" | "right";
  t: ReturnType<typeof useClock>["t"];
  exit: number;
}) {
  const sign = side === "left" ? -1 : 1;
  // The half slides in from its own edge, then parts like a door on the way out.
  const x = sign * (1200 * (1 - t(0, 0.4)) + 1250 * exit);
  const figX = sign * 260 * (1 - t(0.15, 0.7));
  const name = t(0.45, 0.7, Easing.out(Easing.back(1.4)));
  const rank = rankText(pl);
  return (
    <div className={`iv-vs-half ${side}`} style={{ transform: `translateX(${x}px)` }}>
      <div className="iv-vs-bg" />
      <div className="iv-vs-fig" style={{ transform: `translateX(${figX}px)` }}>
        <Img src={pl.avatarUrl} />
      </div>
      <div className="iv-vs-shade" />
      <div className="iv-vs-info">
        <span
          className="iv-vs-name"
          style={{
            fontSize: fitPx(pl.nickname, 150, 760),
            opacity: t(0.45, 0.55),
            transform: `scale(${1.5 - 0.5 * name})`,
          }}
        >
          {pl.nickname}
        </span>
        <span className="iv-vs-elo" style={{ opacity: t(0.65, 0.9) }}>
          <b>{pl.eloRate} ELO</b>
          {rank && <span> · {rank}</span>}
        </span>
        <div className="iv-vs-stats" style={{ opacity: t(0.75, 1.05) }}>
          <span>
            <i>PB</i>
            <b>{formatTime(pl.pbMs)}</b>
          </span>
          <span>
            <i>AVG</i>
            <b>{formatTime(pl.avgMs)}</b>
          </span>
          <span>
            <i>GAMES</i>
            <b>{pl.gamesPlayed.toLocaleString()}</b>
          </span>
          <span>
            <i>WIN RATE</i>
            <b>{pl.winRatePct.toFixed(1)}%</b>
          </span>
        </div>
      </div>
    </div>
  );
}

export const Intro: FC<{ props: OverlayProps }> = ({ props: p }) => {
  const { frame, total, t, exit } = useClock(p);
  if (frame >= total) return null;
  const seed = seedLine(p);
  const centre = t(0.9, 1.2) * (1 - exit);
  const vs = t(0.5, 0.85, Easing.out(Easing.back(2)));
  const gone = 1 - Math.min(1, exit * 2);
  // No whole-card fade: the halves part like doors and the gameplay shows through the gap.
  return (
    <AbsoluteFill className="iv iv-vs" style={{ opacity: t(0, 0.1, (n) => n) }}>
      <VersusSide pl={p.left} side="left" t={t} exit={exit} />
      <VersusSide pl={p.right} side="right" t={t} exit={exit} />
      <div className="iv-vs-seam" style={{ opacity: gone, transform: `scaleY(${t(0.3, 0.55)})` }} />
      <div className="iv-vs-top" style={{ opacity: centre }}>
        {p.playoffLabel && <span className="playoff">{p.playoffLabel} ·</span>}
        <span>{[seed, p.matchPlayedLabel].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="iv-vs-vs" style={{ opacity: gone, transform: `scale(${vs * (1 + exit)})` }}>
        VS
      </div>
      <div style={{ opacity: centre }}>{!p.playoffLabel && <H2H p={p} />}</div>
    </AbsoluteFill>
  );
};
