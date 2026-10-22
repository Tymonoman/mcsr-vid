/**
 * Pure read side of `npm run ab-report` (src/cli/abReport.ts): which finished Test & Compare
 * experiments count, and how to roll their arms up by title style and by thumbnail concept. Split
 * out of the CLI entry point so it stays importable from a test — `src/cli/` itself is "entry
 * points nothing imports" (CLAUDE.md's Layout table).
 */
import type { Experiment } from "./studioExperiments.js";

const TIE_HEADLINE = "They all performed well";

export interface AbReportArmRow {
  name: string;
  /** The control arm's own style is the cache option its saved hook matches, else "picked"
   *  (`TitleTcTarget.controlStyle`, studioWorker.ts) — undefined only on an arm from before 18 Oct
   *  2026 (the manual tc-plan.json title branch, or any thumbnail arm). */
  style?: string;
  /** A thumbnail arm's `settings.concept` ("live" | "big-heads" | "seed-scenery"): the 22 Oct 2026
   *  hand-planned concept tests only, undefined on every earlier thumbnail arm. */
  concept?: string;
  share?: number;
  winner: boolean;
}

export interface AbReportRow {
  id: string;
  videoId?: string;
  /** RFC 3339 — when the test started; with `end`, the window the CLI's `--analytics` reads. */
  start?: string;
  /** RFC 3339 — when `setExperimentChecked` recorded the finished result. */
  end: string;
  controlArm: string;
  tie: boolean;
  arms: AbReportArmRow[];
}

export interface ArmAggregate {
  /** The style or concept the arms were grouped by. */
  key: string;
  /** Finished tests with an arm of this key. */
  tests: number;
  wins: number;
  /** Arms in a test Studio named another arm the winner of. */
  losses: number;
  ties: number;
  /** null when no arm of this key ever had a readable share. */
  meanShare: number | null;
  n: number;
  /** Mean of (arm share − the same test's control share), in points, over the non-control arms with
   *  both shares; null when there is none (a key only ever the control). */
  meanDelta: number | null;
}

/** Engaged share of views and subscribers per 1,000 engaged views — what subscribers track here
 *  (22 Oct 2026: views follow impressions, subscribers follow engaged views). null with nothing to
 *  divide by. Shared with the experiment engine's per-arm totals (experimentsEvaluator.ts). */
export function engagedRates(m: { views: number; engagedViews: number; subscribersGained: number }): {
  engagedRatio: number | null;
  subsPer1kEngaged: number | null;
} {
  return {
    engagedRatio: m.views > 0 ? m.engagedViews / m.views : null,
    subsPer1kEngaged: m.engagedViews > 0 ? (m.subscribersGained / m.engagedViews) * 1000 : null,
  };
}

/**
 * Finished (`status: "done"`) `tc` experiments on `variable` at or after `sinceIso`, newest first —
 * the whole-file read belongs to the CLI; this just shapes experiments already in hand.
 */
export function finishedTests(
  experiments: readonly Experiment[],
  sinceIso: string,
  variable: "title" | "thumbnail" = "title",
): AbReportRow[] {
  return experiments
    .filter(
      (e): e is Experiment & { end: string } =>
        e.kind === "tc" &&
        e.variable === variable &&
        e.status === "done" &&
        typeof e.end === "string" &&
        Date.parse(e.end) >= Date.parse(sinceIso),
    )
    .map((e) => {
      const result = (e.result ?? {}) as {
        watchTimeShare?: Record<string, number>;
        winner?: string;
        headline?: string;
      };
      return {
        id: e.id,
        videoId: e.videos[0]?.videoId,
        ...(e.start ? { start: e.start } : {}),
        end: e.end,
        controlArm: e.controlArm ?? "control",
        tie: result.headline === TIE_HEADLINE,
        arms: e.arms.map((a) => ({
          name: a.name,
          style: a.style,
          concept: (a.settings as { concept?: string } | undefined)?.concept,
          share: result.watchTimeShare?.[a.name],
          winner: result.winner === a.name,
        })),
      };
    })
    .sort((a, b) => (a.end < b.end ? 1 : -1));
}

/** An arm's share minus its own test's control share, in points; undefined for the control itself
 *  or a missing share. */
export function shareDelta(row: AbReportRow, arm: AbReportArmRow): number | undefined {
  const control = row.arms.find((a) => a.name === row.controlArm)?.share;
  return arm.name === row.controlArm || arm.share === undefined || control === undefined
    ? undefined
    : arm.share - control;
}

/**
 * Wins/losses/ties, mean share and mean delta vs control per `keyOf(arm)`, counting only arms that
 * carry a key. A tie credits every keyed arm in that experiment; a win only the winning one; a
 * loss every other arm of a test that has a winner.
 */
export function aggregateArms(
  rows: readonly AbReportRow[],
  keyOf: (arm: AbReportArmRow) => string | undefined,
): ArmAggregate[] {
  const byKey = new Map<
    string,
    { tests: Set<string>; wins: number; losses: number; ties: number; shares: number[]; deltas: number[] }
  >();
  for (const row of rows) {
    const hasWinner = row.arms.some((a) => a.winner);
    for (const arm of row.arms) {
      const key = keyOf(arm);
      if (key === undefined) continue;
      const s = byKey.get(key) ?? { tests: new Set(), wins: 0, losses: 0, ties: 0, shares: [], deltas: [] };
      s.tests.add(row.id);
      if (arm.share !== undefined) s.shares.push(arm.share);
      const delta = shareDelta(row, arm);
      if (delta !== undefined) s.deltas.push(delta);
      if (arm.winner) s.wins++;
      else if (hasWinner) s.losses++;
      if (row.tie) s.ties++;
      byKey.set(key, s);
    }
  }
  const mean = (xs: number[]): number | null =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return [...byKey.entries()]
    .map(([key, s]) => ({
      key,
      tests: s.tests.size,
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      meanShare: mean(s.shares),
      n: s.shares.length,
      meanDelta: mean(s.deltas),
    }))
    .sort((a, b) => b.n - a.n);
}

export const aggregateByStyle = (rows: readonly AbReportRow[]): ArmAggregate[] =>
  aggregateArms(rows, (a) => a.style);

/** The operator's bar for a thumbnail concept (22 Oct 2026): ≥3 finished tests, ≥2 wins, mean delta
 *  ≥ +3 points. Only ever reported — "improvements should still be ab tested", so nothing adopts. */
export const ADOPT_RULE = { minTests: 3, minWins: 2, minMeanDelta: 3 } as const;

export function readyToAdopt(a: ArmAggregate): boolean {
  return (
    a.tests >= ADOPT_RULE.minTests &&
    a.wins >= ADOPT_RULE.minWins &&
    a.meanDelta !== null &&
    a.meanDelta >= ADOPT_RULE.minMeanDelta
  );
}

export const aggregateByConcept = (rows: readonly AbReportRow[]): (ArmAggregate & { ready: boolean })[] =>
  aggregateArms(rows, (a) => a.concept).map((a) => ({ ...a, ready: readyToAdopt(a) }));
