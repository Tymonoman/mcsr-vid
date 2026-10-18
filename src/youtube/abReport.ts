/**
 * Pure read side of `npm run ab-report` (src/cli/abReport.ts): which finished title Test &
 * Compare experiments count, and how to roll their arms up by style. Split out of the CLI entry
 * point so it stays importable from a test — `src/cli/` itself is "entry points nothing imports"
 * (CLAUDE.md's Layout table).
 */
import type { Experiment } from "./studioExperiments.js";

const TIE_HEADLINE = "They all performed well";

export interface AbReportArmRow {
  name: string;
  /** The control arm's own style is the cache option its saved hook matches, else "picked"
   *  (`TitleTcTarget.controlStyle`, studioWorker.ts) — undefined only on an arm from before 18 Oct
   *  2026 (the manual tc-plan.json title branch, or any thumbnail arm). */
  style?: string;
  share?: number;
  winner: boolean;
}

export interface AbReportRow {
  id: string;
  videoId?: string;
  /** RFC 3339 — when `setExperimentChecked` recorded the finished result. */
  end: string;
  tie: boolean;
  arms: AbReportArmRow[];
}

export interface StyleAggregate {
  style: string;
  wins: number;
  ties: number;
  /** null when no arm of this style ever had a readable share. */
  meanShare: number | null;
  n: number;
}

/**
 * Finished (`status: "done"`) title `tc` experiments at or after `sinceIso`, newest first — the
 * whole-file read belongs to the CLI; this just shapes experiments already in hand.
 */
export function finishedTitleTests(experiments: readonly Experiment[], sinceIso: string): AbReportRow[] {
  return experiments
    .filter(
      (e): e is Experiment & { end: string } =>
        e.kind === "tc" &&
        e.variable === "title" &&
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
        end: e.end,
        tie: result.headline === TIE_HEADLINE,
        arms: e.arms.map((a) => ({
          name: a.name,
          style: (a as { style?: string }).style,
          share: result.watchTimeShare?.[a.name],
          winner: result.winner === a.name,
        })),
      };
    })
    .sort((a, b) => (a.end < b.end ? 1 : -1));
}

/**
 * Wins/ties/mean watch-time share per style, counting only arms that carry one. A planned-by-
 * `titleTcTargets` control arm carries "picked" (or the real style its own saved hook matches),
 * so the operator's own picks get their own bucket alongside the styles they skipped — an arm
 * from before 18 Oct 2026 with no style at all is simply left out. A tie credits every styled arm
 * in that experiment; a win credits only the winning one.
 */
export function aggregateByStyle(rows: readonly AbReportRow[]): StyleAggregate[] {
  const byStyle = new Map<string, { wins: number; ties: number; shares: number[] }>();
  for (const row of rows) {
    for (const arm of row.arms) {
      if (arm.style === undefined) continue;
      const s = byStyle.get(arm.style) ?? { wins: 0, ties: 0, shares: [] };
      if (arm.share !== undefined) s.shares.push(arm.share);
      if (arm.winner) s.wins++;
      if (row.tie) s.ties++;
      byStyle.set(arm.style, s);
    }
  }
  return [...byStyle.entries()]
    .map(([style, s]) => ({
      style,
      wins: s.wins,
      ties: s.ties,
      meanShare: s.shares.length ? s.shares.reduce((a, b) => a + b, 0) / s.shares.length : null,
      n: s.shares.length,
    }))
    .sort((a, b) => b.n - a.n);
}
