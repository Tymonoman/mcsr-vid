// Self-check for sync.ts: synthesizes two fake "clips" (loud sine burst = world-load thump,
// over quiet background noise) with a known time offset between them, then verifies
// computeSyncOffset recovers the true match-start time (thump + THUMP_LEAD_SEC) even when the
// coarse API-derived estimate handed in is a few seconds off. Run: npx tsx src/sync.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSyncOffset } from "./sync.js";

const THUMP_LEAD_SEC = 10; // must match sync.ts

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-500)))));
  });
}

/** Builds a synthetic clip: quiet pink noise bed with a loud short sine burst (the "thump") at thumpAtSec. */
async function buildClip(outPath: string, totalDurSec: number, thumpAtSec: number): Promise<void> {
  const thumpMs = Math.round(thumpAtSec * 1000);
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=${totalDurSec}:c=pink:a=0.02`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=90:duration=0.4",
    "-filter_complex",
    `[1:a]adelay=${thumpMs},apad=whole_dur=${totalDurSec}[thump];[0:a][thump]amix=inputs=2:duration=first:dropout_transition=0[out]`,
    "-map",
    "[out]",
    outPath,
  ]);
}

const tmpDir = await mkdtemp(path.join(tmpdir(), "mcsr-sync-test-"));
try {
  const clipAPath = path.join(tmpDir, "a.wav");
  const clipBPath = path.join(tmpDir, "b.wav");

  const thumpAtA = 12.0;
  const trueMatchStartA = thumpAtA + THUMP_LEAD_SEC; // 22.0

  const deltaSec = 5.3; // clip B's recording started later relative to clip A
  const thumpAtB = thumpAtA + deltaSec; // 17.3
  const trueMatchStartB = thumpAtB + THUMP_LEAD_SEC; // 27.3

  // Coarse API-derived estimate for B, deliberately off by a couple seconds from the truth,
  // simulating imprecision in the date/runtime-derived offset from vodAcquisition.ts.
  const estimatedMatchStartB = trueMatchStartB - 1.5;

  await Promise.all([
    buildClip(clipAPath, 35, thumpAtA),
    buildClip(clipBPath, 35, thumpAtB),
  ]);

  const result = await computeSyncOffset(clipAPath, clipBPath, trueMatchStartA, estimatedMatchStartB);

  assert.ok(
    Math.abs(result.clipBCueTimeSec - trueMatchStartB) < 0.2,
    `expected corrected match start near ${trueMatchStartB}s, got ${result.clipBCueTimeSec}s`,
  );
  assert.ok(
    result.confidence > 0.3,
    `expected high confidence correlating on the thump, got ${result.confidence}`,
  );

  console.log(
    `OK: recovered clip B match start ${result.clipBCueTimeSec.toFixed(3)}s ` +
      `(true ${trueMatchStartB}s), confidence ${result.confidence.toFixed(3)}`,
  );
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
