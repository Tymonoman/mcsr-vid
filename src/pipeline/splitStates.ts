import { resolveSplitSide } from "../../remotion/resolveSplitSide.js";
import type { OverlayProps } from "../../remotion/types.js";

/**
 * The frames on which the splits region of the overlay actually changes.
 *
 * Everything left of the RTA column is a pure function of `frame` through `resolveSplitSide`,
 * and that function is a step function: a side flips from "pending" to its time on its own
 * reveal frame, and a missing side flips to "dnf" when the run ends. So for a whole match the
 * region has only a handful of distinct appearances — at most 2 per split row plus one — and
 * rendering it as ~17k video frames was drawing the same image thousands of times over.
 *
 * `resolveSplitSide` is the single source of truth here rather than a re-derivation of it:
 * segmentsFor asks it what each frame looks like instead of assuming a formula, so the two
 * cannot drift apart.
 */
export interface SplitSegment {
  /** First frame of the segment, inclusive. */
  startFrame: number;
  /** One past the last frame, so `endFrame - startFrame` is the length. */
  endFrame: number;
}

type StateProps = Pick<
  OverlayProps,
  | "splits"
  | "timerStartFrame"
  | "runResultMs"
  | "durationInFrames"
  | "fps"
  | "postRollCta"
  | "midRollCta"
  | "teaser"
>;

/** Seconds after the finish before the meta column becomes the subscribe card. */
export const CTA_DELAY_SEC = 3;

/**
 * The first frame of the subscribe card, or null when there is none: no recorded finish (the
 * card would never be right), or the card turned off. Read by the overlay and by the state
 * enumeration below, so the still that carries the card starts on exactly this frame.
 */
export function ctaFrameOf(props: StateProps): number | null {
  if (props.postRollCta === false || props.runResultMs === null) return null;
  return Math.ceil(runEndFrameOf(props) + CTA_DELAY_SEC * props.fps);
}

/** Frames [start, end) of a line shown `atSec` after match start for `forSec`, if it ends before the run does. */
function windowOf(props: StateProps, atSec: number, forSec: number): [number, number] | null {
  if (forSec <= 0) return null;
  const start = Math.ceil(props.timerStartFrame + atSec * props.fps);
  const end = Math.ceil(start + forSec * props.fps);
  return end <= runEndFrameOf(props) ? [start, end] : null;
}

/**
 * The frames [start, end) of the mid-race subscribe line, or null when there is none or it
 * would not fit before the run ends. Read by the overlay and by the state enumeration, so the
 * stills that carry it start and stop on exactly these frames.
 */
export function midRollFramesOf(props: StateProps): [number, number] | null {
  return props.midRollCta ? windowOf(props, props.midRollCta.atSec, props.midRollCta.forSec) : null;
}

/**
 * The frames [start, end) of the first-minute "COMING UP" line (src/pipeline/teaser.ts), or null
 * when there is none: nothing qualified, it is switched off, it would still be up when the moment
 * it promises arrives, or it would share a frame with the mid-race subscribe line — that one
 * wins, as the older setting and the one the operator measured.
 */
export function teaserFramesOf(props: StateProps): [number, number] | null {
  const t = props.teaser;
  const w = t ? windowOf(props, t.atSec, t.forSec) : null;
  if (!t || !w || w[1] > props.timerStartFrame + (t.momentMs / 1000) * props.fps) return null;
  const mid = midRollFramesOf(props);
  return mid && w[0] < mid[1] && mid[0] < w[1] ? null : w;
}

/** Mirrors Overlay.tsx's useTimer: a run with no recorded result never resolves to DNF. */
export function runEndFrameOf(props: StateProps): number {
  return props.runResultMs !== null
    ? props.timerStartFrame + (props.runResultMs / 1000) * props.fps
    : props.durationInFrames;
}

/**
 * A string that is equal for two frames exactly when the splits region renders identically.
 * Only the fields SplitRowView actually reads are included.
 */
function fingerprint(props: StateProps, frame: number): string {
  const runEndFrame = runEndFrameOf(props);
  const ctaFrame = ctaFrameOf(props);
  const rows = props.splits
    .map((row) => {
      const l = resolveSplitSide(row.leftMs, props.timerStartFrame, props.fps, runEndFrame, frame);
      const r = resolveSplitSide(row.rightMs, props.timerStartFrame, props.fps, runEndFrame, frame);
      const show = (s: ReturnType<typeof resolveSplitSide>) => (s.kind === "time" ? `t${s.ms}` : s.kind);
      return `${show(l)}|${show(r)}`;
    })
    .join(",");
  // The meta column is part of the same still, so the card's appearance is a state change too —
  // and so are the mid-race line's and the teaser's, both edges.
  const on = (w: [number, number] | null) => w !== null && frame >= w[0] && frame < w[1];
  return `${rows};cta:${ctaFrame !== null && frame >= ctaFrame};mid:${on(midRollFramesOf(props))};teaser:${on(teaserFramesOf(props))}`;
}

/**
 * Candidate change frames, from the two things that can flip a side's state. Computing these
 * rather than scanning all ~17k frames keeps this cheap; the fingerprint check below still
 * decides, so an over-broad candidate list only costs a redundant still, never a wrong one.
 */
function candidateFrames(props: StateProps): number[] {
  const frames = new Set<number>([0]);
  const runEndFrame = runEndFrameOf(props);
  let hasMissingSide = false;
  for (const row of props.splits) {
    for (const ms of [row.leftMs, row.rightMs]) {
      if (ms === null) {
        hasMissingSide = true;
        continue;
      }
      // resolveSplitSide reveals on `frame >= revealFrame`, so the first *integer* frame that
      // shows it is the ceiling.
      frames.add(Math.ceil(props.timerStartFrame + (ms / 1000) * props.fps));
    }
  }
  if (hasMissingSide) frames.add(Math.ceil(runEndFrame));
  const ctaFrame = ctaFrameOf(props);
  if (ctaFrame !== null) frames.add(ctaFrame);
  for (const w of [midRollFramesOf(props), teaserFramesOf(props)]) {
    if (w) w.forEach((f) => frames.add(f));
  }
  return [...frames].filter((f) => f >= 0 && f < props.durationInFrames).sort((a, b) => a - b);
}

/**
 * Contiguous frame ranges over which the splits region is unchanging, covering
 * [0, durationInFrames) with no gap and no overlap.
 */
export function splitSegments(props: StateProps): SplitSegment[] {
  const segments: SplitSegment[] = [];
  let previous: string | null = null;
  for (const frame of candidateFrames(props)) {
    const current = fingerprint(props, frame);
    // A candidate that renders the same as the segment before it is not a new still — two splits
    // landing in the same frame, or a reveal that coincides with the DNF flip.
    if (current === previous) continue;
    if (segments.length > 0) segments[segments.length - 1]!.endFrame = frame;
    segments.push({ startFrame: frame, endFrame: props.durationInFrames });
    previous = current;
  }
  return segments;
}
