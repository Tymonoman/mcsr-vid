// Self-check for sync.ts and thumpDetect.ts. Synthesizes "clips" (a loud sine burst = the
// world-load thump, over a noise bed) with known thump positions, then checks that
// computeSyncOffset recovers match start in BOTH clips — and, just as importantly, that it
// refuses to answer when the audio does not support one.
// Run: npx tsx src/sync.test.ts
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

interface Thump {
  atSec: number;
  amplitude: number;
}

/**
 * Builds a synthetic clip: a noise bed plus zero or more sine-burst "thumps".
 *
 * Beds:
 *  - "quiet"    : near-silent pink noise.
 *  - "loud"     : a bass rumble and speech-band chatter, each seeded per clip. This is what a
 *                 real stream sounds like — two streamers' backgrounds are unrelated, so the
 *                 beds do not correlate with each other and only the thump aligns.
 *  - "periodic" : a metronomic 2 Hz kick, identical in both clips. Deliberately pathological:
 *                 a perfectly repeating impulse train correlates equally well at every multiple
 *                 of its period, so no alignment is recoverable and the only correct answer is
 *                 to refuse.
 */
async function buildClip(
  outPath: string,
  totalDurSec: number,
  thumps: Thump[],
  bed: "quiet" | "loud" | "periodic" = "quiet",
  seed = 1,
): Promise<void> {
  const inputs: string[] = [];
  const filters: string[] = [];
  const mix: string[] = [];
  let n = 0;

  inputs.push("-f", "lavfi", "-i", `anoisesrc=d=${totalDurSec}:c=pink:a=0.02:seed=${seed}`);
  mix.push(`[${n}:a]`);
  n++;

  if (bed === "periodic") {
    inputs.push("-f", "lavfi", "-i", `aevalsrc='0.35*sin(2*PI*60*t)*exp(-9*mod(t,0.5))':d=${totalDurSec}`);
    mix.push(`[${n}:a]`);
    n++;
  } else if (bed === "loud") {
    inputs.push("-f", "lavfi", "-i", `anoisesrc=d=${totalDurSec}:c=brown:a=0.30:seed=${seed * 7 + 1}`);
    filters.push(`[${n}:a]lowpass=f=200[rumble]`);
    mix.push("[rumble]");
    n++;
    inputs.push("-f", "lavfi", "-i", `anoisesrc=d=${totalDurSec}:c=white:a=0.25:seed=${seed * 13 + 5}`);
    filters.push(
      `[${n}:a]bandpass=f=1400:width_type=h:w=1600,volume='0.5+0.5*sin(2*PI*2.7*t)':eval=frame[chatter]`,
    );
    mix.push("[chatter]");
    n++;
  }

  for (const thump of thumps) {
    inputs.push("-f", "lavfi", "-i", "sine=frequency=90:duration=0.4");
    filters.push(
      `[${n}:a]volume=${thump.amplitude},adelay=${Math.round(thump.atSec * 1000)},apad=whole_dur=${totalDurSec}[t${n}]`,
    );
    mix.push(`[t${n}]`);
    n++;
  }

  filters.push(
    `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0,volume=${mix.length}[out]`,
  );
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", outPath]);
}

const tmpDir = await mkdtemp(path.join(tmpdir(), "mcsr-sync-test-"));
try {
  const CLIP_DUR = 90;
  const clip = (name: string) => path.join(tmpDir, `${name}.wav`);

  // Kept well clear of t=0 so the detection windows never hit extractMonoWav's
  // `Math.max(0, startSec)` clamp, which would shift the window and confound the arithmetic.
  const thumpA = 30.0;
  const trueStartA = thumpA + THUMP_LEAD_SEC; // 40.0
  const delta = 5.3; // clip B started recording later
  const thumpB = thumpA + delta; // 35.3
  const trueStartB = thumpB + THUMP_LEAD_SEC; // 45.3

  await Promise.all([
    buildClip(clip("a"), CLIP_DUR, [{ atSec: thumpA, amplitude: 1 }]),
    buildClip(clip("b"), CLIP_DUR, [{ atSec: thumpB, amplitude: 1 }]),
  ]);

  // --- 1. Both coarse estimates wrong, in different directions ---------------------------
  // The old code corrected only clip B, treating A's estimate as ground truth, so A's error
  // passed straight into the answer. Both must now come back right.
  const result = await computeSyncOffset(clip("a"), clip("b"), trueStartA - 4, trueStartB + 2.5);

  assert.ok(
    Math.abs(result.clipACueTimeSec - trueStartA) < 0.2,
    `clip A match start: expected ~${trueStartA}s, got ${result.clipACueTimeSec}s — A's own estimate was 4s out`,
  );
  assert.ok(
    Math.abs(result.clipBCueTimeSec - trueStartB) < 0.2,
    `clip B match start: expected ~${trueStartB}s, got ${result.clipBCueTimeSec}s`,
  );
  assert.ok(result.confidence > 0.5, `expected agreement to earn high confidence, got ${result.confidence}`);
  assert.ok(
    result.residualSec !== null && Math.abs(result.residualSec) < 0.05,
    `detections and correlation should agree to under 50ms, residual was ${result.residualSec}`,
  );
  console.log(
    `OK: recovered A ${result.clipACueTimeSec.toFixed(3)}s (true ${trueStartA}) and ` +
      `B ${result.clipBCueTimeSec.toFixed(3)}s (true ${trueStartB}) from estimates 4s and 2.5s out — ` +
      `${result.detail}`,
  );

  // --- 2. The decoy: a LOUDER false thump near the real one -------------------------------
  // A re-log, or the previous match's world load, sitting inside 150s of pre-roll. The old
  // score divided by a constant with globally-normalized buffers, so it grew with how loud the
  // search window was and preferred the decoy — measured, it returned a 4.3s error at
  // confidence 1.34, nine times the 0.15 accept threshold. Being wrong here means the published
  // video starts in the wrong place, so the only acceptable behaviour is to be right or abstain.
  await buildClip(clip("decoy"), CLIP_DUR, [
    { atSec: thumpB, amplitude: 1 },
    { atSec: thumpB - 4.3, amplitude: 2 },
  ]);
  const decoy = await computeSyncOffset(clip("a"), clip("decoy"), trueStartA, trueStartB);
  const decoyIsRight = Math.abs(decoy.clipBCueTimeSec - trueStartB) < 0.2;
  assert.ok(
    decoyIsRight || decoy.confidence < 0.15,
    `with a louder decoy thump, must either land on the real thump or abstain; got ` +
      `${decoy.clipBCueTimeSec.toFixed(3)}s (true ${trueStartB}) at confidence ${decoy.confidence.toFixed(3)}`,
  );
  console.log(
    `OK: decoy thump — ${decoyIsRight ? "locked onto the real thump" : "abstained"} ` +
      `(confidence ${decoy.confidence.toFixed(3)}): ${decoy.detail}`,
  );

  // --- 3. No thump at all (both players tabbed out through the world load) ----------------
  // A bare "loudest peak" always returns something. Confidence must collapse so the pipeline
  // keeps the coarse estimate instead of anchoring the whole video on noise.
  // Different seeds: with the same one both clips are bit-identical noise, which correlates
  // perfectly and tests nothing.
  await Promise.all([
    buildClip(clip("silentA"), CLIP_DUR, [], "quiet", 1),
    buildClip(clip("silentB"), CLIP_DUR, [], "quiet", 2),
  ]);
  const noThump = await computeSyncOffset(clip("silentA"), clip("silentB"), trueStartA, trueStartB);
  assert.ok(
    noThump.confidence < 0.5,
    `with no thump present, confidence must not be high; got ${noThump.confidence.toFixed(3)}`,
  );
  console.log(`OK: no thump — confidence ${noThump.confidence.toFixed(3)}: ${noThump.detail}`);

  // --- 4. A loud stream bed under a real thump ------------------------------------------
  // Rumble plus chatter, seeded differently per clip so the beds are unrelated — as two
  // streamers' backgrounds are. Neither detector is confident enough to anchor on its own here,
  // but the thump is still the only thing the two clips share, so the POVs must line up.
  await Promise.all([
    buildClip(clip("loudA"), CLIP_DUR, [{ atSec: thumpA, amplitude: 1 }], "loud", 1),
    buildClip(clip("loudB"), CLIP_DUR, [{ atSec: thumpB, amplitude: 1 }], "loud", 2),
  ]);
  const loud = await computeSyncOffset(clip("loudA"), clip("loudB"), trueStartA - 2, trueStartB + 1);
  const relativeErr = Math.abs(loud.clipBCueTimeSec - loud.clipACueTimeSec - delta);
  // THE safety property, and the one that matters everywhere: never confidently wrong. A buried
  // thump may legitimately be unrecoverable — what must never happen is a wrong alignment
  // reported above the threshold the pipeline acts on, because that silently moves the
  // published video's start. Abstaining costs an editor one nudge; a confident error ships.
  assert.ok(
    relativeErr < 0.2 || loud.confidence < 0.5,
    `under a stream bed: aligned ${relativeErr.toFixed(3)}s out but still reported ` +
      `confidence ${loud.confidence.toFixed(3)} — a confidently wrong sync: ${loud.detail}`,
  );
  console.log(
    `OK: stream bed — ${relativeErr < 0.2 ? `POVs aligned to ${(relativeErr * 1000).toFixed(0)}ms` : "abstained"}, ` +
      `confidence ${loud.confidence.toFixed(3)}: ${loud.detail}`,
  );

  // --- 4b. A perfectly periodic bed -------------------------------------------------------
  // A metronomic kick correlates just as well at every multiple of its period, so there is no
  // recoverable alignment. Picking one of those peaks would look exactly like success and put
  // the POVs a beat apart, so the only acceptable answer is a low confidence.
  await Promise.all([
    buildClip(clip("periodicA"), CLIP_DUR, [{ atSec: thumpA, amplitude: 0.5 }], "periodic", 1),
    buildClip(clip("periodicB"), CLIP_DUR, [{ atSec: thumpB, amplitude: 0.5 }], "periodic", 2),
  ]);
  const periodic = await computeSyncOffset(clip("periodicA"), clip("periodicB"), trueStartA, trueStartB);
  assert.ok(
    periodic.confidence < 0.5,
    `a periodic bed offers no unique alignment; confidence must stay low, got ${periodic.confidence.toFixed(3)}`,
  );
  console.log(`OK: periodic bed — confidence ${periodic.confidence.toFixed(3)}: ${periodic.detail}`);

  // --- 5. Confidence is a real 0-1 scale --------------------------------------------------
  // It used to be an unbounded dot product; the configured 0.15 threshold could not mean
  // anything consistent across matches while that was true.
  for (const r of [result, decoy, noThump, loud, periodic]) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
  }
  console.log("sync: all checks passed");
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
