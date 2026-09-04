/**
 * The pipeline's progress vocabulary: what a stage is, what it reports, and how sub-steps that
 * report their own 0-100 are folded into one honest number.
 *
 * Split out of pipeline.ts because that file crossed the 500-line cap once stage timing and
 * error attribution landed, and because this half is pure and therefore testable on its own
 * (src/stageProgress.test.ts) — the progress bugs it fixes were arithmetic, not orchestration.
 * pipeline.ts re-exports everything public here, so no consumer imports this directly.
 */
import type { RenderProgress } from "./overlayRender.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";

export type StageId = "fetch" | "download" | "sync" | "render" | "thumbnail" | "write";

export const STAGE_ORDER: StageId[] = ["fetch", "download", "sync", "render", "thumbnail", "write"];

export const STAGE_LABELS: Record<StageId, string> = {
  fetch: "Fetch match data",
  download: "Download VODs",
  sync: "Audio sync check",
  render: "Render overlay",
  thumbnail: "Render thumbnail",
  write: "Write Kdenlive project",
};

/**
 * `warn` is a stage that finished but not cleanly — the sync refinement failing or landing under
 * the confidence threshold, where the pipeline carries on with the coarse offset. It used to
 * report plain `done`, which made a broken sync indistinguishable from a good one unless you
 * read the message text.
 */
export type StageStatus = "pending" | "active" | "done" | "warn" | "error";

export interface StageEvent {
  stage: StageId;
  status: StageStatus;
  /** 0-100; omitted for near-instant stages. */
  percent?: number;
  message?: string;
  /** Date.now() when this stage's status first became "active"; same value across repeat active-emits. */
  startedAtMs?: number;
  /** Wall time the stage took, on terminal events only. Absent when the stage was skipped. */
  durationMs?: number;
}

/**
 * Sub-steps of a stage, as `[start, end]` bands of that stage's own 0-100.
 *
 * A stage that runs several renders back to back can only report progress per render, so
 * forwarding those percentages raw made the bar climb to 100 and reset once per sub-step. The
 * bands are rough measurements, not knobs to tune: the splits band dominates the overlay
 * render, and the webpack bundle dominates the thumbnail, which is otherwise a single still.
 */
export type PhaseWeights<P extends string> = Record<P, readonly [number, number]>;

export const RENDER_PHASE_WEIGHTS: PhaseWeights<RenderProgress["phase"]> = {
  bundling: [0, 10],
  top: [10, 15],
  intro: [15, 30],
  rendering: [30, 100],
};

export const RENDER_PHASE_LABELS: Record<RenderProgress["phase"], string> = {
  bundling: "bundling",
  top: "top band",
  intro: "intro card",
  rendering: "splits band",
};

export const THUMBNAIL_PHASE_WEIGHTS: PhaseWeights<ThumbnailProgress["phase"]> = {
  bundling: [0, 85],
  rendering: [85, 100],
};

export function weighted<P extends string>(weights: PhaseWeights<P>, phase: P, percent: number): number {
  const [start, end] = weights[phase];
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(start + ((end - start) * clamped) / 100);
}

/**
 * Overall percent for downloads that run at the same time.
 *
 * `downloadMatchVods` starts both yt-dlp processes under one `Promise.all`, so their progress
 * lines interleave. The previous `(index + percent/100) / total` formula assumed they ran in
 * sequence — it mapped player 0 onto 0-50% and player 1 onto 50-100%, so consecutive events
 * from the two players slammed the bar back and forth between the halves for the entire
 * download. The mean of the latest reading per player is what actually rises monotonically.
 */
export function aggregateDownloadPercent(latestByIndex: ReadonlyMap<number, number>, total: number): number {
  if (total <= 0) return 0;
  const sum = [...latestByIndex.values()].reduce((a, b) => a + b, 0);
  return Math.round(sum / total);
}

export type StageExtra = Omit<StageEvent, "stage" | "status" | "startedAtMs" | "durationMs">;

export interface StageTracker {
  emit: (e: StageEvent) => void;
  /** Marks a stage in flight. Repeat calls (progress callbacks) keep the original start time. */
  active: (stage: StageId, extra?: StageExtra) => StageEvent;
  /** Terminal event for a stage, carrying the wall time it took. */
  settle: (stage: StageId, status: "done" | "warn" | "error", extra?: StageExtra) => StageEvent;
  /** The stage last touched — i.e. the one that owns a thrown error. */
  current: () => StageId;
}

/**
 * Stage bookkeeping, kept outside the pipeline body so `runPipeline` can wrap it in a try/catch
 * and emit a terminal `error` event naming the stage that actually died. Previously the pipeline
 * only ever threw: `status: "error"` was never emitted by any code path, so the dashboard printed
 * a possibly multi-KB stderr tail into a one-line status field with no indication of which stage
 * produced it. The TUI worked around this locally by synthesising its own error event.
 */
export function createStageTracker(onEvent: (e: StageEvent) => void): StageTracker {
  const startedAt = new Map<StageId, number>();
  let current: StageId = STAGE_ORDER[0]!;

  const active = (stage: StageId, extra: StageExtra = {}): StageEvent => {
    current = stage;
    if (!startedAt.has(stage)) startedAt.set(stage, Date.now());
    return { stage, status: "active", startedAtMs: startedAt.get(stage), ...extra };
  };

  const settle = (stage: StageId, status: "done" | "warn" | "error", extra: StageExtra = {}): StageEvent => {
    current = stage;
    const started = startedAt.get(stage);
    // A stage that reused a cached artifact never went active, so it has no duration to report —
    // that absence is what lets the UI say "cached" rather than "0ms".
    const timing = started === undefined ? {} : { startedAtMs: started, durationMs: Date.now() - started };
    return { stage, status, ...timing, ...extra };
  };

  return { emit: onEvent, active, settle, current: () => current };
}
