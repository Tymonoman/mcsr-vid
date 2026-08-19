import { readBatchList } from "./batchList.js";
import { runPipeline, STAGE_LABELS, type StageEvent } from "./pipeline.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run batch -- <path to file of match URLs/IDs, one per line>");
  process.exit(1);
}

const entries = await readBatchList(filePath);

if (entries.length === 0) {
  console.error(`No match entries found in ${filePath}.`);
  process.exit(1);
}

function onEvent(e: StageEvent) {
  if (e.status === "active") {
    console.error(`  ${STAGE_LABELS[e.stage]}${e.message ? `: ${e.message}` : "..."}`);
  } else if (e.status === "done" && e.message) {
    console.error(`    ${e.message}`);
  }
}

const failures: { entry: string; message: string }[] = [];
let okCount = 0;

for (const entry of entries) {
  console.error(`\n=== ${entry} ===`);
  try {
    const result = await runPipeline(entry, { onEvent });
    console.error(`Done: ${result.projectPath}`);
    console.error(`  chapters: ${result.chaptersPath}`);
    console.error(`  description: ${result.descriptionPath}`);
    okCount++;
  } catch (err) {
    const message = (err as Error).message;
    console.error(`Failed: ${message}`);
    failures.push({ entry, message });
  }
}

console.log(`\n${okCount} ok / ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) {
    console.log(`  ${f.entry}: ${f.message}`);
  }
  process.exit(1);
}
