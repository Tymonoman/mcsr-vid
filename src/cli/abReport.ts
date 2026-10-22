/**
 * npm run ab-report [-- --analytics] — every finished title Test & Compare since the Telegram
 * title picker shipped (18 Oct 2026) and every finished thumbnail concept test (22 Oct 2026):
 * per-arm watch-time share, delta vs control and style/concept, then wins/losses/ties and mean
 * delta by style and by concept, with the concept adoption rule (`src/youtube/abReport.ts`'s own
 * pure functions — this file only reads `.experiments.json` and prints). No network, unless
 * `--analytics`: then one Analytics read per test (own channel, own video) for the video's engaged
 * share and subs per 1,000 engaged views over the test window.
 */
import { whenWarsaw } from "../telegram/report.js";
import {
  ADOPT_RULE,
  aggregateByConcept,
  aggregateByStyle,
  engagedRates,
  finishedTests,
  shareDelta,
  type AbReportRow,
  type ArmAggregate,
} from "../youtube/abReport.js";
import { readExperiments } from "../youtube/studioExperiments.js";
import { getAccessToken } from "../youtube/youtube.js";
import { analytics } from "../youtube/yppProgress.js";

const SINCE_ISO = "2026-10-18T00:00:00.000Z";
const withAnalytics = process.argv.includes("--analytics");

const file = await readExperiments();
const titleRows = finishedTests(file.experiments, SINCE_ISO, "title");
const conceptRows = finishedTests(file.experiments, SINCE_ISO, "thumbnail").filter((r) =>
  r.arms.some((a) => a.concept),
);

const signed = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

/** The video's engaged share and subs per 1,000 engaged over the test window; Analytics lags 2–3
 *  days, so a test that ended yesterday reads short. */
async function windowLine(row: AbReportRow): Promise<string> {
  if (!withAnalytics || !row.videoId || !row.start) return "";
  try {
    const [r] = await analytics(await getAccessToken(), {
      startDate: row.start.slice(0, 10),
      endDate: row.end.slice(0, 10),
      metrics: "views,engagedViews,subscribersGained",
      filters: `video==${row.videoId}`,
    });
    const [views, engagedViews, subscribersGained] = (r ?? [0, 0, 0]).map(Number) as [number, number, number];
    const { engagedRatio, subsPer1kEngaged } = engagedRates({ views, engagedViews, subscribersGained });
    return `  test window: ${views} views, ${engagedRatio === null ? "–" : `${(engagedRatio * 100).toFixed(0)}%`} engaged, ${subsPer1kEngaged === null ? "–" : subsPer1kEngaged.toFixed(2)} subs/1k engaged`;
  } catch (err) {
    return `  test window: Analytics read failed — ${(err as Error).message}`;
  }
}

async function printRows(
  rows: AbReportRow[],
  label: (a: AbReportRow["arms"][number]) => string,
): Promise<void> {
  for (const row of rows) {
    console.log(
      `\n${row.id}${row.videoId ? ` (${row.videoId})` : ""} — finished ${whenWarsaw(row.end)}${row.tie ? " — tie" : ""}`,
    );
    for (const arm of row.arms) {
      const share = arm.share !== undefined ? `${arm.share}%` : "?";
      const delta = shareDelta(row, arm);
      console.log(
        `  ${arm.name.padEnd(12)} ${label(arm).padEnd(22)} share=${share}${delta !== undefined ? ` (${signed(delta)} vs control)` : ""}${arm.winner ? "  WINNER" : ""}`,
      );
    }
    const line = await windowLine(row);
    if (line) console.log(line);
  }
}

const aggLine = (a: ArmAggregate): string =>
  `  ${a.key.padEnd(13)} tests=${a.tests} wins=${a.wins} losses=${a.losses} ties=${a.ties} ` +
  `mean share=${a.meanShare === null ? "?" : `${a.meanShare.toFixed(1)}%`} ` +
  `mean delta=${a.meanDelta === null ? "– (control)" : `${signed(a.meanDelta)} pts`} (n=${a.n})`;

if (titleRows.length === 0) {
  console.log("No finished title tests since 18 Oct 2026.");
} else {
  await printRows(titleRows, (a) => `style=${a.style ?? "-"}`);
  console.log("\nBy style:");
  for (const agg of aggregateByStyle(titleRows)) console.log(aggLine(agg));
}

if (conceptRows.length === 0) {
  console.log("\nNo finished thumbnail concept tests yet.");
} else {
  await printRows(conceptRows, (a) => `concept=${a.concept ?? "-"}`);
  console.log(
    `\nConcepts (ready to adopt: ≥${ADOPT_RULE.minTests} finished tests, ≥${ADOPT_RULE.minWins} wins, ` +
      `mean delta ≥ +${ADOPT_RULE.minMeanDelta} pts; reported only, nothing is adopted):`,
  );
  for (const agg of aggregateByConcept(conceptRows)) {
    console.log(
      `${aggLine(agg)}${agg.meanDelta === null ? "" : agg.ready ? "  READY TO ADOPT" : "  not yet"}`,
    );
  }
}
