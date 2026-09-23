/**
 * npm run series -- <matchId | all> [--join-only]
 *
 * A playoff series as one video, from any of its games' ids (src/playoffs/series.ts): renders every game
 * that has no export yet, joins them into game 1's `series-<g1>.mp4`, writes game 1's title and
 * description for the series. The Short is the dashboard's: opening the series there queues the
 * model's pick, and the Short waits for the operator's hook like any match's. `all` walks every seated
 * slot of the current bracket in date order — the way to work through a tournament on the lab
 * in the daytime, one series at a time. `--join-only` skips the renders: join what is exported,
 * or say which games are not.
 *
 * Runs the pipeline in this process and `export:fast` as the dashboard does. The
 * dashboard's nightly does not know about a run here: start one after 03:00 UTC or on a night
 * the queue is empty, or two renders share the four cores.
 */
import { spawn } from "node:child_process";
import { assembleSeries, renderSeries, type SeriesRunners } from "./series.js";
import { parseMatchId } from "../api/mcsrApi.js";
import { runPipeline } from "../pipeline/pipeline.js";
import { playoffBoard } from "./playoffs.js";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const joinOnly = args.includes("--join-only");
if (!target) {
  console.error("usage: npm run series -- <matchId | all> [--join-only]");
  process.exit(2);
}

const npm = (script: string, ...rest: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    const proc = spawn("npm", ["run", "--silent", script, "--", ...rest], { stdio: "inherit" });
    proc.on("error", (err) => resolve(err.message));
    proc.on("close", (code) => resolve(code === 0 ? null : `exit code ${code}`));
  });

const runners: SeriesRunners = {
  renderGame: (matchId) =>
    runPipeline(String(matchId), {
      onEvent: (e) => {
        if (e.status === "done" || e.status === "error")
          console.error(`  ${e.stage}: ${e.status}${e.message ? ` — ${e.message}` : ""}`);
      },
    })
      .then(() => null)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err))),
  exportGame: (matchId) => npm("export:fast", String(matchId)),
  log: (line) => console.error(line),
};

const ids: number[] = [];
if (target === "all") {
  const board = await playoffBoard();
  for (const slot of board.slots) if (slot.games[0]) ids.push(slot.games[0].matchId);
  console.error(`${ids.length} series with games on the board`);
} else {
  ids.push(parseMatchId(target));
}

let failed = 0;
for (const id of ids) {
  const result = joinOnly ? await assembleSeries(id) : await renderSeries(id, runners);
  console.log(JSON.stringify(result));
  if (result.kind !== "joined" && result.kind !== "current") failed++;
}
process.exit(failed === 0 ? 0 : 1);
