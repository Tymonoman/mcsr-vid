/**
 * The splits visualiser: both players' milestones on one shared time axis.
 *
 * Two lanes rather than a lead-over-time line graph, because the question this answers is "was
 * this match close, and where did it turn", and a reader gets that from two rows of dots
 * drifting apart or crossing far faster than from a signed-gap curve. Time is the x axis, not
 * split index: even spacing would hide the thing that makes a match watchable, which is a
 * player stalling between two milestones.
 *
 * Pure string-building, no DOM and no dependency, so the same function draws the compact card
 * version and the full detail version and the two cannot drift apart.
 */

/** Short forms, for the tick labels. The full label is in the <title> tooltip. */
const SPLIT_SHORT = {
  "Nether enter": "NE",
  "Bastion enter": "BA",
  "Bastion loot": "LOOT",
  Fortress: "FO",
  "Blaze rod": "ROD",
  "Blind travel": "BLIND",
  Stronghold: "SH",
  "End enter": "EE",
  Dragon: "DRAGON",
};

const splitClock = (ms) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const splitEsc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * @param splits  SplitGap[] from computeMetrics: { label, aMs, bMs, gapMs, leader }
 * @param opts    { left, right, compact }  nicknames, and whether this is the card-sized version
 * @returns       an <svg> string, or "" when there is nothing comparable to draw
 */
function splitsChart(splits, { left, right, compact = false } = {}) {
  const points = (splits ?? []).filter((s) => s.aMs !== null || s.bMs !== null);
  if (points.length === 0) return "";

  const maxMs = Math.max(...points.flatMap((s) => [s.aMs ?? 0, s.bMs ?? 0]));
  if (!(maxMs > 0)) return "";

  // The viewBox is the real drawing size and the SVG is scaled by width alone; a fixed box with
  // preserveAspectRatio="none" would stretch the dots into ovals.
  const W = 1000;
  // Nine milestones over 1000 units puts adjacent labels ~60 apart, and a label is about that
  // wide, so every label row is staggered between two heights. Measured: without it "Fortress",
  // "Blaze rod" and "Blind travel" render as "EO ROD BLIND" and the gaps as "+37.0s+4.0s+8.0s".
  const padL = compact ? 10 : 150;
  const padR = compact ? 34 : 40;
  const laneGap = compact ? 30 : 46;
  const topY = compact ? 15 : 62;
  const H = compact ? 60 : 168;
  const span = W - padL - padR;

  const x = (ms) => padL + (ms / maxMs) * span;
  const laneA = topY;
  const laneB = topY + laneGap;

  const parts = [];

  // Rails first, so every dot sits on top of its own lane.
  for (const [y, colour] of [
    [laneA, "var(--crimson)"],
    [laneB, "var(--warped)"],
  ]) {
    parts.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${colour}" stroke-width="1.5" opacity="0.35"/>`,
    );
  }

  if (!compact) {
    const fit = (n) => {
      const name = String(n ?? "");
      return name.length > 12 ? `${name.slice(0, 11)}\u2026` : name;
    };
    parts.push(
      `<text x="${padL - 14}" y="${laneA + 6}" text-anchor="end" class="sc-name" fill="var(--crimson)">${splitEsc(fit(left))}</text>`,
      `<text x="${padL - 14}" y="${laneB + 6}" text-anchor="end" class="sc-name" fill="var(--warped)">${splitEsc(fit(right))}</text>`,
    );
  }

  points.forEach((s, i) => {
    const stagger = i % 2;
    const tickX = x(Math.max(s.aMs ?? 0, s.bMs ?? 0));

    // The connector is the whole point of the chart: its length IS the gap at that milestone,
    // so a close match reads as a row of short stubs and a blowout as long diagonals.
    if (s.aMs !== null && s.bMs !== null) {
      const leaderIsA = s.aMs < s.bMs;
      parts.push(
        `<line x1="${x(s.aMs)}" y1="${laneA}" x2="${x(s.bMs)}" y2="${laneB}" ` +
          `stroke="${leaderIsA ? "var(--crimson)" : "var(--warped)"}" stroke-width="1" opacity="0.45"/>`,
      );
    }

    const r = compact ? 3.5 : 4.5;
    if (s.aMs !== null) {
      parts.push(
        `<circle cx="${x(s.aMs)}" cy="${laneA}" r="${r}" fill="var(--crimson)"><title>${splitEsc(left ?? "left")} — ${splitEsc(s.label)} ${splitClock(s.aMs)}</title></circle>`,
      );
    }
    if (s.bMs !== null) {
      parts.push(
        `<circle cx="${x(s.bMs)}" cy="${laneB}" r="${r}" fill="var(--warped)"><title>${splitEsc(right ?? "right")} — ${splitEsc(s.label)} ${splitClock(s.bMs)}</title></circle>`,
      );
    }
    // A milestone only one player reached is the loudest signal on the chart — someone died or
    // never got there — so the empty lane is marked rather than left as a lone unexplained dot.
    if (s.aMs === null || s.bMs === null) {
      parts.push(
        `<circle cx="${tickX}" cy="${s.aMs === null ? laneA : laneB}" r="${r}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>`,
      );
    }

    // No text at all on a card: nine tick labels across ~300px collapse into overlapping noise,
    // and the shape alone — stub connectors versus long diagonals — already says "close" or
    // "blowout". The names are in the <title> tooltips either way.
    if (compact) return;
    parts.push(
      `<text x="${tickX}" y="${laneB + 30 + stagger * 24}" ` +
        `text-anchor="middle" class="sc-tick">${splitEsc(SPLIT_SHORT[s.label] ?? s.label)}</text>`,
    );
    // Gaps go *above* the lanes: below, they would be a third row competing with the two
    // staggered tick rows for the same strip of space.
    if (s.gapMs !== null) {
      parts.push(
        `<text x="${tickX}" y="${laneA - 18 - stagger * 24}" text-anchor="middle" class="sc-gap">+${(s.gapMs / 1000).toFixed(1)}s</text>`,
      );
    }
  });

  return (
    `<svg class="splitschart${compact ? " compact" : ""}" viewBox="0 0 ${W} ${H}" ` +
    `role="img" aria-label="Split timeline for ${splitEsc(left ?? "left")} versus ${splitEsc(right ?? "right")}">` +
    parts.join("") +
    `</svg>`
  );
}
