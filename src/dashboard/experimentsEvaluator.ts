/**
 * Turns a running "between" experiment's videos into per-arm totals and a verdict, at a daily
 * tick (`evaluateExperiments`, called close to 04:15 UTC from server.ts) — own-channel reads only:
 * the Reporting API's daily reach reports (src/youtube/youtube.ts `impressionsSince`,
 * src/dashboard/youtubeRoutes.ts `totalReach`) and the Analytics API (src/youtube/yppProgress.ts
 * `analytics`, the same one-video filter shape its own per-video engagement call already uses).
 *
 * "tc" experiments (Studio's own Test & Compare, written by the automation on another branch) are
 * never touched: the loop below skips anything whose `kind !== "between"` before it reads or
 * writes a single field of it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { getAccessToken, impressionsSince } from "../youtube/youtube.js";
import { analytics } from "../youtube/yppProgress.js";
import { readUpload } from "../youtube/youtubeStore.js";
import { totalReach } from "./youtubeRoutes.js";
import {
  readExperimentsOrNull,
  slotEntriesFor,
  writeExperiments,
  type Experiment,
  type ExperimentArm,
  type ExperimentsFile,
} from "./experiments.js";
import { saveSettings } from "./settings.js";

/** The 1 Oct 2026 post-mortem: a 4,590-impression CTR gap (9.36% vs 2.25%) reversed at 126,745
 *  (2.77% vs 2.59%). Below this, "inconclusive" is the only honest verdict. */
const MIN_IMPRESSIONS = 1000;
/** The video is the unit (15 Oct 2026, the "why" report): which match a video carries moves its
 *  CTR far more than any arm does, so x1's per-video CTRs spread ~38x wider than one pooled rate
 *  allows and the pooled z-test named a winner in 66–77% of no-effect simulations. No verdict
 *  until every arm has this many videos with the metric, whatever the impressions. */
export const MIN_VIDEOS_PER_ARM = 8;
/** Two-sided, split across the non-control arms (Bonferroni) when there are more than one. */
export const ALPHA = 0.05;
const SHUFFLES = 10_000;
/** Fixed, so the same per-video values give the same p every day. */
const SEED = 0x5eed;

export interface VideoMetrics {
  impressions: number;
  clicks: number;
  views: number;
  engagedViews: number;
  averageViewPercentage: number;
  subscribersGained: number;
  /** The audience still watching at 10% of the video (Analytics' audienceWatchRatio), as a
   *  percentage: the first minute, where the retention opening (x5) should show. Absent when
   *  Analytics has no curve for it yet. */
  retentionAt10?: number;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * One video's metrics since its publish time, live. `videoIdHint` is the pick's own `videoId`
 * when the experiment recorded one; otherwise it comes from the match's `youtube.json`, as does
 * the since-date. `sinceHint` (the experiment's start) stands in for a record that is gone — a
 * deleted match directory: an enrolled video has no reach before it, so the sums are the same.
 */
async function liveMetricsFor(
  matchId: number,
  videoIdHint?: string,
  sinceHint?: string,
): Promise<VideoMetrics | null> {
  const record = await readUpload(matchId);
  const videoId = videoIdHint ?? record?.videoId;
  if (!videoId) return null;
  const sinceIso =
    (record?.publishAt && Date.parse(record.publishAt) <= Date.now()
      ? record.publishAt
      : record?.uploadedAt) ?? sinceHint;
  if (!sinceIso) return null;
  const sinceDate = sinceIso.slice(0, 10);

  // The CSV's own date column reads "20261012", the since-date "2026-10-08": compare one format.
  const sinceCompact = sinceDate.replaceAll("-", "");
  const rows = (await impressionsSince(config.youtubeReportingJobId, sinceDate)).filter(
    (r) => r.videoId === videoId && r.date.replaceAll("-", "") >= sinceCompact,
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
  const curve = await analytics(token, {
    startDate: sinceDate,
    endDate: ymd(new Date()),
    metrics: "audienceWatchRatio",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${videoId}`,
  }).catch(() => []); // an extra number, never a reason to fail the metrics every experiment needs
  const at10 = curve.find((r) => Math.abs(Number(r[0]) - 0.1) < 0.005)?.[1];
  return {
    ...(at10 !== undefined ? { retentionAt10: Number(at10) * 100 } : {}),
    impressions,
    clicks: Math.round(clicks),
    views: Number(views),
    engagedViews: Number(engagedViews),
    averageViewPercentage: Number(averageViewPercentage),
    subscribersGained: Number(subscribersGained),
  };
}

export type VideoRow = VideoMetrics & { matchId: number; videoId?: string };

export interface ArmTotals {
  arm: string;
  videos: number;
  impressions: number;
  clicks: number;
  views: number;
  engagedViews: number;
  subscribersGained: number;
  /** View-weighted mean, and the per-video values (only videos with views — `videos` counts every
   *  one). */
  avgViewPercentage: number;
  avgViewPercentages: number[];
  /** Every video's own metrics: what `verdictFor` decides on, one value per video. */
  perVideo: VideoRow[];
}

export type MetricsFetcher = (
  matchId: number,
  videoIdHint: string | undefined,
  sinceHint?: string,
) => Promise<VideoMetrics | null>;

/** Every arm's totals, in the experiment's own arm order. `fetch` defaults to the live Reporting +
 *  Analytics reads above; tests inject a map so no network call is needed to pin a verdict rule. */
export async function armTotalsFor(
  exp: Experiment,
  fetch: MetricsFetcher = liveMetricsFor,
): Promise<ArmTotals[]> {
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
      perVideo: [],
    };
    let weightedPctSum = 0;
    for (const v of exp.videos.filter((v) => v.arm === arm.name)) {
      const m = await fetch(v.matchId, v.videoId, exp.start);
      if (!m) continue;
      totals.videos++;
      totals.impressions += m.impressions;
      totals.clicks += m.clicks;
      totals.views += m.views;
      totals.engagedViews += m.engagedViews;
      totals.subscribersGained += m.subscribersGained;
      totals.perVideo.push({ matchId: v.matchId, ...(v.videoId ? { videoId: v.videoId } : {}), ...m });
      // A video with no views yet (scheduled, or inside Analytics' 2–3 day lag) has no retention
      // to measure — its 0% would drag the arm down and still count toward the video floor.
      if (m.views > 0) totals.avgViewPercentages.push(m.averageViewPercentage);
      weightedPctSum += m.averageViewPercentage * m.views;
    }
    totals.avgViewPercentage = totals.views > 0 ? weightedPctSum / totals.views : 0;
    out.push(totals);
  }
  return out;
}

/** The two-proportion z-score, arm vs control: positive means the arm's CTR is the higher one; 0
 *  (not NaN or Infinity) when either side has nothing to divide by. Reported in a CTR verdict's
 *  text, never the decision: it treats every impression as independent, and ours are not. */
export function twoProportionZ(clicksA: number, nA: number, clicksB: number, nB: number): number {
  if (nA <= 0 || nB <= 0) return 0;
  const pA = clicksA / nA;
  const pB = clicksB / nB;
  const pooled = (clicksA + clicksB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  return se > 0 ? (pA - pB) / se : 0;
}

/** Two-sided permutation test on the difference in means, `a` vs `b`: the share of `SHUFFLES`
 *  random relabellings of the pooled values whose gap is at least the observed one. Each value is
 *  one video, so a big video counts once, not once per impression. */
export function permutationP(a: number[], b: number[], shuffles = SHUFFLES, seed = SEED): number {
  const all = [...a, ...b];
  const total = all.reduce((x, y) => x + y, 0);
  const gap = (sumA: number) => Math.abs(sumA / a.length - (total - sumA) / b.length);
  const observed = gap(a.reduce((x, y) => x + y, 0));
  let s = seed >>> 0; // mulberry32
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let extreme = 0;
  for (let i = 0; i < shuffles; i++) {
    let sumA = 0;
    for (let j = 0; j < a.length; j++) {
      const k = j + Math.floor(rand() * (all.length - j)); // partial Fisher–Yates
      [all[j], all[k]] = [all[k]!, all[j]!];
      sumA += all[j]!;
    }
    if (gap(sumA) >= observed - 1e-9) extreme++;
  }
  return (extreme + 1) / (shuffles + 1);
}

export interface Verdict {
  text: string;
  /** The non-control arm the verdict names a winner for, or null (not enough videos, inconclusive,
   *  no verdict yet, or the control winning). What `settle` below adopts when the experiment ends
   *  with `adoptWinner`. */
  winnerArm: string | null;
}

/** One value per video for the experiment's metric, null for a video that has none yet. */
interface MetricRule {
  name: string;
  of: (m: VideoMetrics) => number | null;
  fmt: (x: number) => string;
}
const RULES: [RegExp, MetricRule][] = [
  // Before the average view % rule, whose pattern also reads "retention".
  [
    /retention at 10/,
    {
      name: "retention at 10%",
      of: (m) => (m.views > 0 && m.retentionAt10 !== undefined ? m.retentionAt10 : null),
      fmt: (x) => `${x.toFixed(1)}%`,
    },
  ],
  [
    /ctr|click/,
    {
      name: "CTR",
      of: (m) => (m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null),
      fmt: (x) => `${x.toFixed(2)}%`,
    },
  ],
  [
    /view ?(%|perc)|retention/,
    {
      name: "average view %",
      of: (m) => (m.views > 0 ? m.averageViewPercentage : null),
      fmt: (x) => `${x.toFixed(1)}%`,
    },
  ],
  [
    /sub/,
    {
      name: "subs per 1,000 views",
      of: (m) => (m.views > 0 ? (m.subscribersGained / m.views) * 1000 : null),
      fmt: (x) => x.toFixed(2),
    },
  ],
];

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Per video, never pooled: every arm needs `MIN_VIDEOS_PER_ARM` videos with the metric, then any
 * arm under `MIN_IMPRESSIONS`, then each non-control arm's per-video values against the control's
 * through `permutationP`; a winner only at p < `ALPHA` (split across the non-control arms). The
 * pooled two-proportion z rides along in a CTR verdict's text as a number, never as the decision.
 * Anything short of that is "no verdict yet" — the honest default.
 */
export function verdictFor(exp: Experiment, arms: ArmTotals[]): Verdict {
  const rule = RULES.find(([re]) => re.test(exp.metric.toLowerCase()))?.[1];
  if (!rule) return { text: `numbers only (no per-video rule for "${exp.metric}")`, winnerArm: null };
  const sides = arms.map((a) => ({
    arm: a,
    xs: a.perVideo.map(rule.of).filter((x): x is number => x !== null),
  }));
  const thin = [...sides].sort((a, b) => a.xs.length - b.xs.length)[0];
  if (thin && thin.xs.length < MIN_VIDEOS_PER_ARM)
    return {
      text: `not enough videos (${thin.xs.length} with ${rule.name} in arm ${thin.arm.arm}, ${MIN_VIDEOS_PER_ARM} needed)`,
      winnerArm: null,
    };
  const under = arms
    .filter((a) => a.impressions < MIN_IMPRESSIONS)
    .sort((a, b) => a.impressions - b.impressions)[0];
  if (under)
    return { text: `inconclusive (${under.impressions} impressions in arm ${under.arm})`, winnerArm: null };

  const control = sides.find((s) => s.arm.arm === exp.controlArm) ?? sides[0]!;
  let best: { side: (typeof sides)[number]; p: number } | null = null;
  for (const side of sides) {
    if (side === control) continue;
    const p = permutationP(side.xs, control.xs);
    if (!best || p < best.p) best = { side, p };
  }
  if (!best) return { text: "numbers only", winnerArm: null };
  const ahead = mean(best.side.xs) > mean(control.xs) ? best.side : control;
  const behind = ahead === control ? best.side : control;
  const z =
    rule.name === "CTR"
      ? `; pooled z=${twoProportionZ(best.side.arm.clicks, best.side.arm.impressions, control.arm.clicks, control.arm.impressions).toFixed(2)}`
      : "";
  const numbers =
    `${ahead.arm.arm} ${rule.fmt(mean(ahead.xs))} vs ${behind.arm.arm} ${rule.fmt(mean(behind.xs))} per video, ` +
    `${ahead.xs.length} vs ${behind.xs.length} videos, ${best.p < 0.001 ? "p<0.001" : `p=${best.p.toFixed(3)}`}${z}`;
  if (best.p >= ALPHA / (sides.length - 1))
    return { text: `no verdict yet on ${rule.name} (${numbers})`, winnerArm: null };
  return {
    text: `${ahead.arm.arm} wins on ${rule.name} (${numbers})`,
    // The control already is the default: nothing for `settle` to adopt.
    winnerArm: ahead === control ? null : ahead.arm.arm,
  };
}

const isYesterday = (date: string, today: string): boolean =>
  Date.parse(today) - Date.parse(date) === 86_400_000;

/**
 * At `end`: a declared winner with `adoptWinner` becomes the new default; otherwise (no winner, or
 * a winner the operator did not ask to be adopted automatically) the control arm's settings are
 * reapplied — a render arm earlier in the run may have left a different one live. Only `settings`
 * is ever pushed through `saveSettings`; an arm whose lever was a `slot` (the publish-hour or
 * Short-delay mechanism, which has no standing Settings field to adopt into) is recorded in the
 * decision with nothing to apply.
 *
 * A `saveSettings` failure (a typo'd key, a value `validateOverrides` rejects) is thrown, not
 * swallowed: `evaluateExperiments` catches it exactly like a Reporting/Analytics read failing, so
 * the experiment stays `running` and is retried tomorrow rather than being marked `done` with a
 * decision claiming a setting change took effect when it did not.
 */
function settle(exp: Experiment, verdict: Verdict): void {
  const winner = verdict.winnerArm ? exp.arms.find((a) => a.name === verdict.winnerArm) : undefined;
  const adopted = winner && exp.adoptWinner;
  const arm: ExperimentArm | undefined = adopted ? winner : exp.arms.find((a) => a.name === exp.controlArm);
  if (arm?.settings && Object.keys(arm.settings).length) saveSettings(arm.settings);
  exp.status = "done";
  exp.decision = adopted
    ? `adopted ${winner.name}: ${verdict.text}`
    : `kept ${exp.controlArm}: ${verdict.text}`;
}

/**
 * Fills every "between" experiment's `videos` array from what's on disk, before the evaluation
 * loop below ever reads it — nothing wrote `exp.videos` until this existed. Idempotent (checked
 * by `matchId` per experiment below), never duplicates, never removes.
 *
 *  (a) RENDER experiments: a match directory's own `experiment-arm.json`
 *      (`writeExperimentArmFile`, src/dashboard/experiments.ts) names the experiment and the arm
 *      it rendered under; `videoId` comes from `youtube.json` when the match has one by now — a
 *      match not yet uploaded is enrolled anyway and simply has no metrics to fetch until it is.
 *  (b) SLOT experiments: a long-form upload record (`youtube.json`, never a Short) whose publish
 *      time (`publishAt`, else `uploadedAt`) falls on a date whose slot entries (`slotEntriesFor`)
 *      names the experiment; the arm is the arm whose own `slot.rankedHoursUtc` is exactly that
 *      one publish hour (an hour-split experiment: two hours a day, each its own arm) when such
 *      an arm exists, else the schedule entry's own `arm`.
 *
 * Mutates the experiments inside `data` in place (same objects `evaluateExperiments`'s own loop
 * then reads), rather than returning a copy — there is nothing else to do with the result.
 */
async function enrolVideos(data: ExperimentsFile): Promise<void> {
  const byId = new Map(data.experiments.filter((e) => e.kind === "between").map((e) => [e.id, e]));
  if (byId.size === 0) return;

  for (const matchId of listProcessedMatchIds()) {
    const upload = await readUpload(matchId, "video");

    // (a) This match's own render-arm snapshot, if it has one.
    const armFile = path.join(matchDir(matchId), "experiment-arm.json");
    if (existsSync(armFile)) {
      try {
        const body = JSON.parse(readFileSync(armFile, "utf8")) as { experimentId?: string; arm?: string };
        const exp = body.experimentId ? byId.get(body.experimentId) : undefined;
        const enrolled = exp?.videos.find((v) => v.matchId === matchId);
        if (exp && body.arm && !enrolled) {
          exp.videos.push({ matchId, arm: body.arm, ...(upload ? { videoId: upload.videoId } : {}) });
        } else if (enrolled && !enrolled.videoId && upload) {
          // Enrolled before its upload: keep the id now, so a later delete of the match directory
          // (its youtube.json with it) leaves the video measurable.
          enrolled.videoId = upload.videoId;
        }
      } catch (err) {
        console.error(`experiments: ${armFile} unreadable — ${describeError(err)}`);
      }
    }

    // (b) This match's own upload, into every slot experiment its publish date names (a
    // publish-hour experiment and a Short-delay experiment can share a date).
    if (!upload) continue;
    const publishIso = upload.publishAt ?? upload.uploadedAt;
    for (const entry of slotEntriesFor(publishIso.slice(0, 10), data)) {
      const exp = byId.get(entry.experimentId);
      if (!exp || exp.videos.some((v) => v.matchId === matchId)) continue;
      const hour = new Date(publishIso).getUTCHours();
      const hourArm = exp.arms.find(
        (a) => a.slot?.rankedHoursUtc?.length === 1 && a.slot.rankedHoursUtc[0] === hour,
      );
      exp.videos.push({ matchId, arm: hourArm?.name ?? entry.arm, videoId: upload.videoId });
    }
  }
}

export interface EvaluatorDeps {
  fetch: MetricsFetcher;
  now: () => number;
}

/**
 * Once a UTC day (`evaluatedOn`): `enrolVideos` fills every between experiment's `videos` array
 * from disk first, then every running one gets fresh per-arm totals and a verdict; one whose
 * `end` has passed is settled (`settle`) and marked done. A fetch failure leaves the experiment
 * as it was and is remembered (`lastEvalFailure`); a second failure the very next day's attempt
 * sets `needsHuman` rather than retrying silently forever.
 *
 * Guarded against itself (`evaluating`, the same shape as `shortTick`'s `ticking` in
 * src/dashboard/shortFlow.ts): server.ts's 15-minute tick fires this unconditionally, and several
 * experiments' worth of serial network reads can outlast one tick's 15 minutes, so a second call
 * must not start a second read-modify-write over the same file while the first is still in flight.
 * The final write also re-reads the file fresh rather than reusing the `data` read at the top: the
 * same 15-minute tick runs `applyScheduledRenderArm` right before this, and a long evaluation must
 * not clobber (revert) an `appliedOn` — or any schedule/baseline edit — that call made in the
 * meantime; only an experiment this run actually changed (enrolled a new video into, or ran the
 * running-loop below on) is overlaid onto whatever the file holds now — a "done" or "planned"
 * experiment `enrolVideos` found nothing new for is left to whatever `fresh` holds for it, so a
 * concurrent edit to one of its other fields survives too.
 *
 * ponytail: `evaluatedOn`'s read-then-write still assumes one dashboard process against the
 * mediaDir (`claimSlot`, src/dashboard/shortFlow.ts, same assumption) — two processes could both
 * evaluate the same day; add a cross-process lock if that ever stops being true.
 */
let evaluating = false;

export async function evaluateExperiments(deps: Partial<EvaluatorDeps> = {}): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    const { fetch = liveMetricsFor, now = Date.now } = deps;
    const nowMs = now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    // A corrupt file (a hand-edit's trailing comma) is left exactly as it is — never rewritten as
    // empty — and with no `evaluatedOn`, so the first tick after it is fixed evaluates the day.
    const data = readExperimentsOrNull();
    if (!data || data.evaluatedOn === today) return;

    // Only a between experiment `enrolVideos` actually added a video to goes into `touched` here
    // — not every between experiment regardless of whether anything changed. `touched` is what the
    // final write below force-writes over whatever is on disk by then; a "done" or "planned"
    // experiment enrolVideos left untouched (nothing new on disk for it this run) must stay exactly
    // that untouched, so a concurrent edit to one of its *other* fields (`needsHumanAck`, say, from
    // the operator or another route) is never overwritten by this run's stale copy of it.
    const videoCounts = new Map(
      data.experiments.filter((e) => e.kind === "between").map((e) => [e.id, e.videos.length]),
    );
    await enrolVideos(data);

    const touched = new Map<string, Experiment>(
      data.experiments
        .filter((e) => e.kind === "between" && e.videos.length !== videoCounts.get(e.id))
        .map((e) => [e.id, e]),
    );
    for (const exp of data.experiments) {
      if (exp.kind !== "between" || exp.status !== "running") continue;
      try {
        const arms = await armTotalsFor(exp, fetch);
        const verdict = verdictFor(exp, arms);
        exp.result = { arms, computedAt: new Date(nowMs).toISOString() };
        exp.verdict = verdict.text;
        exp.evaluatedAt = new Date(nowMs).toISOString();
        // Cleared only once settle() has returned: a settle that throws must leave yesterday's
        // failure in place for the catch's two-days-running check below.
        if (exp.end <= today) settle(exp, verdict);
        delete exp.lastEvalFailure;
        delete exp.needsHuman;
      } catch (err) {
        const message = describeError(err);
        if (exp.lastEvalFailure && isYesterday(exp.lastEvalFailure.date, today)) exp.needsHuman = message;
        exp.lastEvalFailure = { date: today, message };
        console.error(`experiments: ${exp.id} evaluation failed — ${message}`);
      }
      touched.set(exp.id, exp);
    }

    const fresh = readExperimentsOrNull();
    if (!fresh) return;
    writeExperiments({
      ...fresh,
      experiments: fresh.experiments.map((e) => touched.get(e.id) ?? e),
      evaluatedOn: today,
    });
  } finally {
    evaluating = false;
  }
}
