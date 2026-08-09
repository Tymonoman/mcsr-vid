import { STAGE_ORDER } from "./pipeline.js";
import { listMatchStatuses } from "./matchStatus.js";

const entries = await listMatchStatuses();

if (entries.length === 0) {
  console.log("No matches found under media/. Run `npm run generate-project -- <match>` first.");
  process.exit(0);
}

const header = ["MATCH", "LEFT", "RIGHT", ...STAGE_ORDER.map((s) => s.toUpperCase())];
const rows = entries.map((e) => [
  String(e.matchId),
  e.leftNickname,
  e.rightNickname,
  ...STAGE_ORDER.map((s) => (e.stages[s] ? "✓" : "✗")),
]);

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const printRow = (cols: string[]) => console.log(cols.map((c, i) => c.padEnd(widths[i]!)).join("  "));

printRow(header);
printRow(widths.map((w) => "-".repeat(w)));
for (const row of rows) printRow(row);
