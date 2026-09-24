import type { FC } from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { formatConstantLabel, formatTime } from "./format.js";
import { introFrameCount } from "./layout.js";
import type { OverlayProps, PlayerIdentity } from "./types.js";

/*
 * Three alternative intro cards for the operator to choose from (24 Sept 2026: "change it up
 * think of another layout"), selected by `props.introLayout`. Same data as the current card;
 * every animated element takes its transform inline and gets its position from left/top in the
 * CSS, never a CSS transform — an inline transform replaces the whole CSS one (the PlayerCard
 * pitfall in CLAUDE.md).
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
  const fade = interpolate(frame, [0, fps * 0.25, exitStart, total], [0, 1, 1, 0], clamp);
  return { t, exit, fade };
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

type Win = "l" | "r" | "";
const cmp = (a: number, b: number, higherWins: boolean): Win =>
  a === b ? "" : a > b === higherWins ? "l" : "r";

interface Row {
  label: string;
  l: string;
  r: string;
  win: Win;
}

function statRows(p: OverlayProps): Row[] {
  const { left: L, right: R } = p;
  const pct = (n: number) => `${n.toFixed(1)}%`;
  return [
    { label: "PB", l: formatTime(L.pbMs), r: formatTime(R.pbMs), win: cmp(L.pbMs, R.pbMs, false) },
    { label: "Average", l: formatTime(L.avgMs), r: formatTime(R.avgMs), win: cmp(L.avgMs, R.avgMs, false) },
    {
      label: "Games",
      l: L.gamesPlayed.toLocaleString(),
      r: R.gamesPlayed.toLocaleString(),
      win: cmp(L.gamesPlayed, R.gamesPlayed, true),
    },
    {
      label: "Win rate",
      l: pct(L.winRatePct),
      r: pct(R.winRatePct),
      win: cmp(L.winRatePct, R.winRatePct, true),
    },
  ];
}

/** The head-to-head, or what stands in for it: a playoff game drops the lifetime ranked record
 *  (it would read as the series score — see VersusRecord in Intro.tsx), 0–0 says "first meeting". */
function H2H({ p, className }: { p: OverlayProps; className: string }) {
  if (p.playoffLabel) return <div className={`${className} playoff`}>{p.playoffLabel}</div>;
  const { h2hLeftWins: l, h2hRightWins: r } = p;
  return (
    <div className={className}>
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

/* ---------- 1. Tale of the tape ---------- */

const Tape: FC<{ p: OverlayProps }> = ({ p }) => {
  const { t, exit, fade } = useClock(p);
  const lr = rankText(p.left);
  const rr = rankText(p.right);
  const rows: Row[] = [
    {
      label: "Elo",
      l: String(p.left.eloRate),
      r: String(p.right.eloRate),
      win: cmp(p.left.eloRate, p.right.eloRate, true),
    },
    {
      label: p.left.seed || p.right.seed ? "Seed" : "World rank",
      l: lr?.replace(/ WORLD$/, "") ?? "—",
      r: rr?.replace(/ WORLD$/, "") ?? "—",
      win:
        p.left.eloRank != null && p.right.eloRank != null && !p.left.seed
          ? cmp(p.left.eloRank, p.right.eloRank, false)
          : "",
    },
    ...statRows(p),
  ];
  const figIn = t(0.05, 0.55);
  const figX = (sign: number) => sign * (-760 * (1 - figIn) - 500 * exit);
  const seed = seedLine(p);
  const nameW = 440;

  return (
    <AbsoluteFill className="iv iv-tape" style={{ opacity: fade }}>
      <div className="iv-tape-fig left" style={{ transform: `translateX(${figX(1)}px)` }}>
        <Img src={p.left.avatarUrl} />
      </div>
      <div className="iv-tape-fig right" style={{ transform: `translateX(${figX(-1)}px)` }}>
        <Img src={p.right.avatarUrl} />
      </div>
      {/* One line above the table: the tournament when there is one, else the seed. A playoff game
          has no head-to-head row, so its seed line goes to the foot with the date. */}
      <div className="iv-tape-top" style={{ opacity: t(0.9, 1.2) }}>
        {p.playoffLabel ? <span className="playoff">{p.playoffLabel}</span> : seed && <span>{seed}</span>}
      </div>
      <div className="iv-tape-table">
        <div
          className="iv-tape-head"
          style={{ opacity: t(0.3, 0.6), transform: `scale(${0.9 + 0.1 * t(0.3, 0.6)})` }}
        >
          <span className="name l" style={{ fontSize: fitPx(p.left.nickname, 92, nameW) }}>
            {p.left.nickname}
          </span>
          <span className="vs">VS</span>
          <span className="name r" style={{ fontSize: fitPx(p.right.nickname, 92, nameW) }}>
            {p.right.nickname}
          </span>
        </div>
        {rows.map((row, i) => {
          const k = t(0.45 + i * 0.07, 0.75 + i * 0.07);
          return (
            <div
              className="iv-tape-row"
              key={row.label}
              style={{ opacity: k, transform: `scaleX(${0.6 + 0.4 * k})` }}
            >
              <b className={row.win === "l" ? "l" : ""}>{row.l}</b>
              <span className="lbl">{row.label}</span>
              <b className={row.win === "r" ? "r" : ""}>{row.r}</b>
            </div>
          );
        })}
        {!p.playoffLabel && (
          <div className="iv-tape-row h2h" style={{ opacity: t(0.94, 1.24) }}>
            {p.h2hLeftWins === 0 && p.h2hRightWins === 0 ? (
              <span className="first">First meeting</span>
            ) : (
              <>
                <b className={p.h2hLeftWins > p.h2hRightWins ? "l" : ""}>{p.h2hLeftWins}</b>
                <span className="lbl">Head to head</span>
                <b className={p.h2hRightWins > p.h2hLeftWins ? "r" : ""}>{p.h2hRightWins}</b>
              </>
            )}
          </div>
        )}
      </div>
      <div className="iv-tape-date" style={{ opacity: t(0.9, 1.2) }}>
        {[p.playoffLabel && seed, p.matchPlayedLabel].filter(Boolean).join(" · ")}
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 2. Versus screen ---------- */

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

const Versus: FC<{ p: OverlayProps }> = ({ p }) => {
  const { t, exit } = useClock(p);
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
      <div style={{ opacity: centre }}>
        {!p.playoffLabel && <H2H p={p} className="iv-vs-h2h" />}
      </div>
    </AbsoluteFill>
  );
};

/* ---------- 3. Player cards ---------- */

function PlayerCardGui({
  pl,
  side,
  t,
}: {
  pl: PlayerIdentity;
  side: "left" | "right";
  t: ReturnType<typeof useClock>["t"];
}) {
  const d = side === "left" ? 0 : 0.15;
  const flip = t(0.1 + d, 0.6 + d);
  const rank = rankText(pl);
  const rows: [string, string][] = [
    ["Elo", String(pl.eloRate)],
    ["PB", formatTime(pl.pbMs)],
    ["Average", formatTime(pl.avgMs)],
    ["Games", pl.gamesPlayed.toLocaleString()],
    ["Win rate", `${pl.winRatePct.toFixed(1)}%`],
  ];
  return (
    <div
      className={`iv-card ${side}`}
      style={{
        opacity: flip > 0 ? 1 : 0,
        transform: `perspective(1800px) rotateY(${(1 - flip) * (side === "left" ? -90 : 90)}deg)`,
      }}
    >
      <div className="iv-card-title">
        <span className="name" style={{ fontSize: fitPx(pl.nickname, 84, 628) }}>
          {pl.nickname}
        </span>
        {rank && <span className="rank">{rank}</span>}
      </div>
      <div className="iv-card-window">
        <Img src={pl.avatarUrl} />
      </div>
      <div className="iv-card-rows">
        {rows.map(([label, value], i) => (
          <div key={label} style={{ opacity: t(0.6 + d + i * 0.06, 0.8 + d + i * 0.06) }}>
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

const Cards: FC<{ p: OverlayProps }> = ({ p }) => {
  const { t, fade } = useClock(p);
  const seed = seedLine(p);
  return (
    <AbsoluteFill className="iv iv-cards" style={{ opacity: fade }}>
      <div className="iv-cards-top" style={{ opacity: t(0.85, 1.15) }}>
        <H2H p={p} className="iv-cards-h2h" />
        <span className="seed">{[seed, p.matchPlayedLabel].filter(Boolean).join(" · ")}</span>
      </div>
      <PlayerCardGui pl={p.left} side="left" t={t} />
      <PlayerCardGui pl={p.right} side="right" t={t} />
      <div
        className="iv-cards-vs"
        style={{ transform: `scale(${t(0.6, 0.95, Easing.out(Easing.back(2)))})` }}
      >
        VS
      </div>
    </AbsoluteFill>
  );
};

const LAYOUTS = { tape: Tape, versus: Versus, cards: Cards };

export const IntroVariant: FC<{ props: OverlayProps }> = ({ props }) => {
  const Layout = LAYOUTS[props.introLayout ?? "tape"];
  return <Layout p={props} />;
};
