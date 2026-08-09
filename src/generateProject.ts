import { runPipeline, STAGE_LABELS, type StageEvent } from "./pipeline.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run generate-project -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const ac = new AbortController();
process.on("SIGINT", () => {
  console.error("\nInterrupted, cleaning up...");
  ac.abort();
});

function onEvent(e: StageEvent) {
  if (e.status === "active") {
    console.error(`${STAGE_LABELS[e.stage]}${e.message ? `: ${e.message}` : "..."}`);
  } else if (e.status === "done" && e.message) {
    console.error(`  ${e.message}`);
  }
}

try {
  const result = await runPipeline(input, { onEvent, signal: ac.signal });
  console.error(`Done: ${result.projectPath}`);
  console.log(
    JSON.stringify(
      { matchId: result.matchId, projectPath: result.projectPath, thumbnailPath: result.thumbnailPath },
      null,
      2,
    ),
  );
} catch (err) {
  if (ac.signal.aborted) {
    console.error("Aborted.");
    process.exit(130);
  }
  console.error((err as Error).message);
  process.exit(1);
}
