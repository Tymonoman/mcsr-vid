/**
 * npm run ab-report — every finished title Test & Compare since the Telegram title picker shipped
 * (18 Oct 2026): per-arm watch-time share and style, then wins/ties/mean share by style
 * (`src/youtube/abReport.ts`'s own pure functions — this file only reads `.experiments.json` and
 * prints). No network.
 */
import { whenWarsaw } from "../telegram/report.js";
import { aggregateByStyle, finishedTitleTests } from "../youtube/abReport.js";
import { readExperiments } from "../youtube/studioExperiments.js";

const SINCE_ISO = "2026-10-18T00:00:00.000Z";

const file = await readExperiments();
const rows = finishedTitleTests(file.experiments, SINCE_ISO);

if (rows.length === 0) {
  console.log("No finished title tests since 18 Oct 2026.");
} else {
  for (const row of rows) {
    console.log(
      `\n${row.id}${row.videoId ? ` (${row.videoId})` : ""} — finished ${whenWarsaw(row.end)}${row.tie ? " — tie" : ""}`,
    );
    for (const arm of row.arms) {
      const share = arm.share !== undefined ? `${arm.share}%` : "?";
      console.log(
        `  ${arm.name.padEnd(12)} style=${(arm.style ?? "-").padEnd(10)} share=${share}${arm.winner ? "  WINNER" : ""}`,
      );
    }
  }
  console.log("\nBy style:");
  for (const agg of aggregateByStyle(rows)) {
    const mean = agg.meanShare === null ? "?" : `${agg.meanShare.toFixed(1)}%`;
    console.log(
      `  ${agg.style.padEnd(10)} wins=${agg.wins} ties=${agg.ties} mean share=${mean} (n=${agg.n})`,
    );
  }
}
