/**
 * Turns a running "between" experiment's videos into per-arm totals and a verdict, at a daily
 * tick (`evaluateExperiments`, called close to 04:15 UTC from server.ts) — own-channel reads only:
 * the Reporting API's reach report (src/youtube/youtube.ts `latestImpressions`,
 * src/dashboard/youtubeRoutes.ts `totalReach`) and the Analytics API (src/youtube/yppProgress.ts
 * `analytics`, the same one-video filter shape its own per-video engagement call already uses).
 *
 * "tc" experiments (Studio's own Test & Compare, written by the automation on another branch) are
 * never touched: the loop below skips anything whose `kind !== "between"` before it reads or
 * writes a single field of it.
 */
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import { getAccessToken, latestImpressions } from "../youtube/youtube.js";
import { analytics } from "../youtube/yppProgress.js";
import { readUpload } from "../youtube/youtubeStore.js";
import { totalReach } from "./youtubeRoutes.js";
import {
  readExperiments,
  writeExperiments,
  type Experiment,
  type ExperimentArm,
  type ExperimentsFile,
} from "./experiments.js";
import { saveSettings } from "./settings.js";

/** The 1 Oct 2026 post-mortem: a 4,590-impression CTR gap (9.36% vs 2.25%) reversed at 126,745
 *  (2.77% vs 2.59%). Below this, "inconclusive" is the only honest verdict. */
const MIN_IMPRESSIONS = 1000;
const Z_THRESHOLD = 1.96;
/** The retention rule only fires with at least this many videos on each side of the comparison. */
const MIN_RETENTION_VIDEOS = 3;

export interface VideoMetrics {
  impressions: number;
  clicks: number;
  views: number;
  engagedViews: number;
  averageViewPercentage: number;
  subscribersGained: number;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * One video's metrics since its publish time, live. `videoIdHint` is the pick's own `videoId`
 * when the experiment recorded one; otherwise (and always, for the since-date) it comes from the
 * match's `youtube.json`.
 */
async function liveMetricsFor(matchId: number, videoIdHint?: string): Promise<VideoMetrics | null> {
  const record = await readUpload(matchId);
  const videoId = videoIdHint ?? record?.videoId;
  if (!videoId) return null;
  const sinceIso =
    record?.publishAt && Date.parse(record.publishAt) <= Date.now() ? record.publishAt : record?.uploadedAt;
  if (!sinceIso) return null;
  const sinceDate = sinceIso.slice(0, 10);

  const rows = (await latestImpressions(config.youtubeReportingJobId)).filter(
    (r) => r.videoId === videoId && r.date >= sinceDate,
  );
  // totalReach's "weightedCtr" is sum(ctr * impressions) over the filtered rows — already a click
  // count, not a rate, despite the name (src/dashboard/youtubeRoutes.ts).
  const { impressions, weightedCtr: clicks } = totalReach(rows);

  const token = await getAccessToken();
  const analyticsRows = await analytics(token, {
    startDate: sinceDate,
    endDate: ymd(new Date()),
    metrics: "views,engagedViews,averageViewPercentage,subscribersGained",
    filters: `video==${videoId}`,
  });
  const [views, engagedViews, averageViewPercentage, subscribersGained] = analyticsRows[0] ?? [0, 0, 0, 0];
  return {
    impressions,
    clicks: Math.round(clicks),
    views: Number(views),
    engagedViews: Number(engagedViews),
    averageViewPercentage: Number(averageViewPercentage),
    subscribersGained: Number(subscribersGained),
  };
}

export interface ArmTotals {
  arm: string;
  videos: number;
  impressions: number;
  clicks: number;
  views: number;
  engagedViews: number;
  subscribersGained: number;
  /** View-weighted mean, and the per-video values the dominance check in `retentionVerdict` reads. */
  avgViewPercentage: number;
  avgViewPercentages: number[];
}

export type MetricsFetcher = (matchId: number, videoIdHint: string | undefined) => Promise<VideoMetrics | null>;

/** Every arm's totals, in the experiment's own arm order. `fetch` defaults to the live Reporting +
 *  Analytics reads above; tests inject a map so no network call is needed to pin a verdict rule. */
export async function armTotalsFor(exp: Experiment, fetch: MetricsFetcher = liveMetricsFor): Promise<ArmTotals[]> {
  const out: ArmTotals[] = [];
  for (const arm of exp.arms) {
    const totals: ArmTotals = {
      arm: arm.name,
      videos: 0,
      impressions: 0,
      clicks: 0,
      views: 0,
      engagedViews: 0,
      subscribersGained: 0,
      avgViewPercentage: 0,
      avgViewPercentages: [],
    };
    let weightedPctSum = 0;
    for (const v of exp.videos.filter((v) => v.arm === arm.name)) {
      const m = await fetch(v.matchId, v.videoId);
      if (!m) continue;
      totals.videos++;
      totals.impressions += m.impressions;
      totals.clicks += m.clicks;
      totals.views += m.views;
      totals.engagedViews += m.engagedViews;
      totals.subscribersGained += m.subscribersGained;
      totals.avgViewPercentages.push(m.averageViewPercentage);
      weightedPctSum += m.averageViewPercentage * m.views;
    }
    totals.avgViewPercentage = totals.views > 0 ? weightedPctSum / totals.views : 0;
    out.push(totals);
  }
  return out;
}

/** The two-proportion z-score, arm vs control: positive means the arm's CTR is the higher one; 0
 *  (not NaN or Infinity) when either side has nothing to divide by. */
export function twoProportionZ(clicksA: number, nA: number, clicksB: number, nB: number): number {
  if (nA <= 0 || nB <= 0) return 0;
  const pA = clicksA / nA;
  const pB = clicksB / nB;
  const pooled = (clicksA + clicksB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  return se > 0 ? (pA - pB) / se : 0;
}

export interface Verdict {
  text: string;
  /** The non-control arm the verdict names a winner for, or null (inconclusive, no difference, or
   *  "numbers only"). What `settle` below adopts when the experiment ends with `adoptWinner`. */
  winnerArm: string | null;
}

const ctrOf = (a: ArmTotals): number => (a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0);

function ctrVerdict(arms: ArmTotals[], controlArm: string): Verdict {
  const control = arms.find((a) => a.arm === controlArm) ?? arms[0]!;
  let best: { arm: ArmTotals; z: number } | null = null;
  for (const a of arms) {
    if (a.arm === control.arm) continue;
    const z = twoProportionZ(a.clicks, a.impressions, control.clicks, control.impressions);
    if (Math.abs(z) >= Z_THRESHOLD && (!best || Math.abs(z) > Math.abs(best.z))) best = { arm: a, z };
  }
  if (!best) return { text: "no difference on CTR", winnerArm: null };
  const winner = best.z > 0 ? best.arm : control;
  const loser = best.z > 0 ? control : best.arm;
  return {
    text: `${winner.arm} wins on CTR (${ctrOf(winner).toFixed(2)}% vs ${ctrOf(loser).toFixed(2)}%, z=${best.z.toFixed(2)})`,
    winnerArm: winner.arm === control.arm ? null : winner.arm,
  };
}

/**
 * Reports the per-arm view-weighted mean (the numbers always land in `result`, win or not); a
 * winner only when every video of one arm beats every video of another, both with at least
 * `MIN_RETENTION_VIDEOS`. Applied to whichever non-CTR metric the experiment names — the spec only
 * ever gives this one rule, for "average view %", so it is this module's one fallback rather than
 * a family of per-metric rules nothing has asked for yet.
 *
 * ponytail: the video-count floor is checked across every arm in the experiment, not just the
 * pair being compared — fine for the two-arm experiments this channel actually runs; a three-arm
 * test would need a per-pair check.
 */
function retentionVerdict(arms: ArmTotals[], controlArm: string): Verdict {
  const control = arms.find((a) => a.arm === controlArm) ?? arms[0]!;
  if (arms.some((a) => a.videos < MIN_RETENTION_VIDEOS)) return { text: "numbers only", winnerArm: null };
  for (const a of arms) {
    if (a.arm === control.arm) continue;
    const aMin = Math.min(...a.avgViewPercentages);
    const aMax = Math.max(...a.avgViewPercentages);
    const cMin = Math.min(...control.avgViewPercentages);
    const cMax = Math.max(...control.avgViewPercentages);
    if (aMin > cMax)
      return {
        text: `${a.arm} wins on average view % — every video ahead of ${control.arm} (${a.avgViewPercentage.toFixed(1)}% vs ${control.avgViewPercentage.toFixed(1)}%)`,
        winnerArm: a.arm,
      };
    if (cMin > aMax)
      return {
        text: `${control.arm} wins on average view % — every video ahead of ${a.arm} (${control.avgViewPercentage.toFixed(1)}% vs ${a.avgViewPercentage.toFixed(1)}%)`,
        // The control already is the default: nothing for `settle` to adopt.
        winnerArm: null,
      };
  }
  return { text: "numbers only", winnerArm: null };
}

/** Any arm under `MIN_IMPRESSIONS` first, regardless of metric — never a guess on a small sample.
 *  Else the metric's own rule: a two-proportion z-test for CTR, the dominance check otherwise. */
export function verdictFor(exp: Experiment, arms: ArmTotals[]): Verdict {
  const under = arms
    .filter((a) => a.impressions < MIN_IMPRESSIONS)
    .sort((a, b) => a.impressions - b.impressions)[0];
  if (under) return { text: `inconclusive (${under.impressions} impressions in arm ${under.arm})`, winnerArm: null };
  return exp.metric.toLowerCase() === "ctr"
    ? ctrVerdict(arms, exp.controlArm)
    : retentionVerdict(arms, exp.controlArm);
}

const isYesterday = (date: string, today: string): boolean => Date.parse(today) - Date.parse(date) === 86_400_000;

/**
 * At `end`: a declared winner with `adoptWinner` becomes the new default; otherwise (no winner, or
 * a winner the operator did not ask to be adopted automatically) the control arm's settings are
 * reapplied — a render arm earlier in the run may have left a different one live. Only `settings`
 * is ever pushed through `saveSettings`; an arm whose lever was a `slot` (the publish-hour or
 * Short-delay mechanism, which has no standing Settings field to adopt into) is recorded in the
 * decision with nothing to apply.
 */
function settle(exp: Experiment, verdict: Verdict): void {
  exp.status = "done";
  const winner = verdict.winnerArm ? exp.arms.find((a) => a.name === verdict.winnerArm) : undefined;
  const adopted = winner && exp.adoptWinner;
  const arm: ExperimentArm | undefined = adopted ? winner : exp.arms.find((a) => a.name === exp.controlArm);
  if (arm?.settings && Object.keys(arm.settings).length) {
    try {
      saveSettings(arm.settings);
    } catch (err) {
      console.error(`experiments: ${exp.id} could not apply ${arm.name}'s settings — ${describeError(err)}`);
    }
  }
  exp.decision = adopted ? `adopted ${winner.name}: ${verdict.text}` : `kept ${exp.controlArm}: ${verdict.text}`;
}

export interface EvaluatorDeps {
  fetch: MetricsFetcher;
  now: () => number;
}

/**
 * Once a UTC day (`evaluatedOn`): every running "between" experiment gets fresh per-arm totals and
 * a verdict; one whose `end` has passed is settled (`settle`) and marked done. A fetch failure
 * leaves the experiment as it was and is remembered (`lastEvalFailure`); a second failure the very
 * next day's attempt sets `needsHuman` rather than retrying silently forever.
 *
 * ponytail: `evaluatedOn`'s read-then-write is not locked, same as the rest of this codebase's
 * single-dashboard-process assumption (`claimSlot`, src/dashboard/shortFlow.ts) — two dashboard
 * processes against the same mediaDir could both evaluate the same day; add a lock if that ever
 * stops being true.
 */
export async function evaluateExperiments(deps: Partial<EvaluatorDeps> = {}): Promise<void> {
  const { fetch = liveMetricsFor, now = Date.now } = deps;
  const nowMs = now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const data: ExperimentsFile = readExperiments();
  if (data.evaluatedOn === today) return;

  for (const exp of data.experiments) {
    if (exp.kind !== "between" || exp.status !== "running") continue;
    try {
      const arms = await armTotalsFor(exp, fetch);
      const verdict = verdictFor(exp, arms);
      exp.result = { arms, computedAt: new Date(nowMs).toISOString() };
      exp.verdict = verdict.text;
      exp.evaluatedAt = new Date(nowMs).toISOString();
      delete exp.lastEvalFailure;
      delete exp.needsHuman;
      if (exp.end <= today) settle(exp, verdict);
    } catch (err) {
      const message = describeError(err);
      if (exp.lastEvalFailure && isYesterday(exp.lastEvalFailure.date, today)) exp.needsHuman = message;
      exp.lastEvalFailure = { date: today, message };
      console.error(`experiments: ${exp.id} evaluation failed — ${message}`);
    }
  }
  writeExperiments({ ...data, evaluatedOn: today });
}
