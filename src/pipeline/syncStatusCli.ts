import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { offsetIntoClipFromProject } from "./kdenliveProject.js";
import { readSyncOffsets, writeSyncOffsets, type SyncOffsets } from "./syncFile.js";

/**
 * npm run sync-status -- [matchId]
 *
 * What each match's clips are placed against, and a backfill for the ones rendered before
 * sync.json existed: their .kdenlive already carries the corrected offsets (the pipeline spent
 * them there and nowhere else), so they are read back out and written to sync.json rather than
 * re-detected — a re-export then picks them up without re-running a countdown scan or a render.
 *
 * With no id, every match directory is listed and nothing is written.
 */
const arg = process.argv[2];

function projectPathFor(dir: string, id: string): string | null {
  const file = path.join(dir, `match-${id}.kdenlive`);
  return existsSync(file) ? file : null;
}

/** Reads what the generated project placed the two POV clips at. Null unless both are found. */
function deriveFromProject(projectPath: string): { left: number; right: number } | null {
  const xml = readFileSync(projectPath, "utf8");
  const left = offsetIntoClipFromProject(xml, "chain_video_left");
  const right = offsetIntoClipFromProject(xml, "chain_video_right");
  return left === null || right === null ? null : { left, right };
}

const describe = (o: SyncOffsets) =>
  `left ${o.left.toFixed(2)}s, right ${o.right.toFixed(2)}s ` +
  `(${o.source}, ${(o.confidence * 100).toFixed(0)}%) — ${o.detail}`;

/** One line per match; `backfill` writes a derived sync.json when the match has none. */
function report(id: string, backfill: boolean): void {
  const dir = matchDir(Number(id));
  const existing = readSyncOffsets(dir);
  if (existing) {
    console.log(`${id}: ${describe(existing)}`);
    return;
  }
  const project = projectPathFor(dir, id);
  const derived = project && deriveFromProject(project);
  if (!derived) {
    console.log(
      `${id}: no sync.json${project ? " and its .kdenlive places no POV clips" : " and no .kdenlive"} — ` +
        `clips fall back to the coarse ${config.preRollSec}s estimate.`,
    );
    return;
  }
  const offsets: SyncOffsets = {
    ...derived,
    // The project keeps the placement, not the score that produced it; calling it 1 would claim
    // a measurement nobody made.
    confidence: 0,
    detail: `derived from ${path.basename(project)}`,
    source: "derived",
  };
  const drift = (v: number) => `${v >= config.preRollSec ? "+" : ""}${(v - config.preRollSec).toFixed(2)}s`;
  console.log(
    `${id}: derived left ${offsets.left.toFixed(2)}s (${drift(offsets.left)} from the estimate), ` +
      `right ${offsets.right.toFixed(2)}s (${drift(offsets.right)})`,
  );
  if (backfill) {
    writeSyncOffsets(dir, offsets);
    console.log(`${id}: wrote ${path.join(dir, "sync.json")} — re-export to pick it up.`);
  } else {
    console.log(`${id}: run \`npm run sync-status -- ${id}\` to write it.`);
  }
}

if (arg) {
  report(String(Number(arg)), true);
} else {
  const ids = readdirSync(config.mediaDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (ids.length === 0) console.log(`No match directories in ${config.mediaDir}.`);
  // Listing every match must not rewrite every match: backfilling is per-id and deliberate.
  for (const id of ids) report(id, false);
}
