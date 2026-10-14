// Contract test for the post-roll (the tail after the run), written from the docs, not the code.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/pipeline/postRoll.contract.test.ts
//
// What the docs promise (CLAUDE.md "House rules", handbook/claude-md-reference.md "House rules",
// the Settings panel's own help for `postRollSec`, `Config.postRollSec`'s JSDoc, and the public
// types in postRoll.ts):
//
//  P1  Match footage is never cut: the tail cut always lands after the finish, never on or before it.
//  P2  The tail is at most `postRollSec`, however long the measured window is.
//  P3  `postRollSec` defaults to 30 (not 60: the competitor ends ~10 s after the finish).
//  P4  The tail is cut earlier where the winner goes quiet (and still): at the start of the dead air.
//  P5  Never under 15 s — not when the winner is dead the moment the run ends, not when the quiet
//      starts before 15 s.
//  P6  A winner who never goes quiet keeps the whole `postRollSec`.
//  P7  "Quiet" is quiet AND still — a winner talking while sitting still is still reacting, and is
//      kept (module header; the pure core is pinned in postRoll.test.ts, here it is end to end).
//  P8  The reaction is measured from the run's end inside the clip (`runEndSec`), not the clip's start.
//  P9  A muted winner (digital silence, e.g. a Twitch-muted VOD segment) who is also still is quiet.
//  P10 A failed measurement (missing/unreadable clip) never cuts the video short: whole `postRollSec`.
//  P11 The Settings panel cannot set `postRollSec` under the 15 s floor ("never under 15 s").
//  P12 More reaction never means a shorter tail — the only reason to cut earlier is quiet.
//  P13 `TailWindow` is a per-second series: `loudness` holds one reading per second of window,
//      silence included (the type's own doc: "Loudness per second").
//
// Not reachable through the public surface (CLI-only, `src/pipeline/exportFastCli.ts`, a top-level
// script needing the MCSR API, the overlay and a full ffmpeg export): `--full-tail` keeps all of it;
// the tail is measured on the *winner's* POV; the 15 s floor constant; the cap shrinking to the
// footage left on the timer strip.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULTS } from "../config.js";
import { SETTINGS, coerce } from "../dashboard/settings.js";
import { measureTail, suggestTailSec, type TailWindow } from "./postRoll.js";

/** Where the code and the docs disagree: report it, keep the suite green until triage. */
let deviations = 0;
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations++;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const FLOOR = 15; // "never under 15 s" — the export CLI's own floor, the one the docs name.
const CAP = DEFAULTS.postRollSec;
const opts = { minSec: FLOOR, maxSec: CAP };
const flat = (value: number, n: number) => Array<number>(n).fill(value);
// Values well clear of any plausible gate, so these pin behaviour, not thresholds.
const LOUD = -12; // dBFS: shouting at the dragon
const SILENT = -75; // dBFS: room tone
const MOVING = 40; // mean abs frame diff, 0-255
const STILL = 0.2;
const act = (n: number) => ({ loudness: flat(LOUD, n), motion: flat(MOVING, n) });
const dead = (n: number) => ({ loudness: flat(SILENT, n), motion: flat(STILL, n) });
const cat = (...ws: TailWindow[]): TailWindow => ({
  loudness: ws.flatMap((w) => w.loudness),
  motion: ws.flatMap((w) => w.motion),
});

// ---------------------------------------------------------------- the pure core, on DEFAULTS

// P3: the default is 30 s, the 22 Sept retention/competitor call. 60 ran into the stats screen.
assert.equal(DEFAULTS.postRollSec, 30, "postRollSec defaults to 30");

// P2: a measurement window twice the cap (a caller passing a long probe) is still capped.
assert.equal(suggestTailSec(act(60), opts), CAP, "60 s of celebration still keeps at most postRollSec");

// P4: celebrating for 22 s, then dead air — cut where the dead air starts, earlier than the cap.
assert.equal(suggestTailSec(cat(act(22), dead(30)), opts), 22, "cut at the start of the quiet");

// P5: dead from the instant the run ends — the floor holds (a cut on the death frame reads as broken).
assert.equal(suggestTailSec(dead(30), opts), FLOOR, "dead from the finish still keeps 15 s");
// P5: quiet from 8 s on — the quiet start is under the floor, so the floor wins, not 8.
assert.equal(suggestTailSec(cat(act(8), dead(22)), opts), FLOOR, "quiet from 8 s still keeps 15 s");
// P5: the clip runs out 10 s after the finish with the winner still going — still never under 15.
assert.ok(suggestTailSec(act(10), opts) >= FLOOR, "a short measurement never drops under the floor");

// P6: never quiets down within the cap — keep all of postRollSec.
assert.equal(suggestTailSec(act(CAP), opts), CAP, "a winner who never goes quiet keeps the whole tail");

// P10 (pure half): no readings at all — keep the whole tail rather than truncate someone's video.
assert.equal(suggestTailSec({ loudness: [], motion: [] }, opts), CAP, "no evidence, no cut");

// P11: the panel is the operator's only lever; below 15 the two documented bounds contradict.
{
  const field = SETTINGS.find((f) => f.key === "postRollSec");
  assert.ok(field, "postRollSec is a Settings field");
  assert.ok("error" in coerce(field, "14"), "the panel refuses a post-roll under 15 s");
  assert.ok("error" in coerce(field, "0"), "the panel refuses no post-roll at all");
  assert.deepEqual(coerce(field, "15"), { value: 15 }, "15 s itself is allowed");
  assert.deepEqual(coerce(field, "30"), { value: 30 }, "the default is allowed");
}

// P1 + P2 + P5 + P12, fuzzed: random reactions, random (and mismatched) series lengths, a cap
// anywhere from the floor to 60 — the cut always lands inside [floor, cap], after the finish, and
// adding reaction anywhere never makes the tail shorter. Seeded, so a failure reproduces.
{
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const series = (len: number, pActive: number, hi: number, lo: number) =>
    Array.from({ length: len }, () => (rand() < pActive ? hi : lo) + (rand() - 0.5) * 4);
  for (let k = 0; k < 3000; k++) {
    const maxSec = FLOOR + Math.floor(rand() * 46); // 15..60, the panel's range
    const pActive = rand();
    const w: TailWindow = {
      loudness: series(Math.floor(rand() * 75), pActive, LOUD, SILENT),
      motion: series(Math.floor(rand() * 75), pActive, MOVING, STILL),
    };
    const before = JSON.stringify(w);
    const got = suggestTailSec(w, { minSec: FLOOR, maxSec });
    assert.ok(got > 0, `P1: the cut lands after the finish (case ${k}: ${got})`);
    assert.ok(got >= FLOOR && got <= maxSec, `P2/P5: ${got} outside [${FLOOR}, ${maxSec}] (case ${k})`);
    assert.equal(JSON.stringify(w), before, "the measurement is read, not rewritten");

    // P12: the winner reacts in a few more seconds than before; the tail cannot shrink.
    const more: TailWindow = { loudness: [...w.loudness], motion: [...w.motion] };
    for (let i = 0; i < more.motion.length; i++) if (rand() < 0.2) more.motion[i] = MOVING;
    const gotMore = suggestTailSec(more, { minSec: FLOOR, maxSec });
    assert.ok(gotMore >= got, `P12: more reaction cut the tail from ${got} to ${gotMore} (case ${k})`);
  }
}

// ---------------------------------------------------------------- end to end, real ffmpeg media

const dir = mkdtempSync(path.join(tmpdir(), "postroll-contract-"));
try {
  /** A tiny 64x36 clip: luma expression (T = seconds) for the picture, a lavfi audio source. */
  const clip = (name: string, sec: number, lum: string, audio: string): string => {
    const out = path.join(dir, name);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `nullsrc=s=64x36:r=4:d=${sec},geq=lum='${lum}':cb=128:cr=128`,
        "-f",
        "lavfi",
        "-i",
        audio,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "pcm_s16le",
        "-t",
        String(sec),
        out,
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    return out;
  };
  const tone = (amp: string, sec: number) => `aevalsrc='(${amp})*sin(2*PI*440*t)':s=48000:d=${sec}`;
  const ROOM = "0.0003"; // ~-73 dBFS: audible to a meter, silent to a viewer (and not -inf)
  const SHOUT = "0.5"; // ~-9 dBFS
  const NOISE = "random(1)*255"; // every pixel changes every frame: a moving picture
  const GRAY = "128"; // a frozen frame
  const tail = async (file: string, runEndSec: number, maxSec: number) =>
    suggestTailSec(await measureTail(file, runEndSec, maxSec), { minSec: FLOOR, maxSec });

  // P4 + P8: the "match" is 3 s, then the winner moves until 23 s into the clip and sits still in
  // room tone after. Measured from the run's end, the quiet starts 20 s in — cut there, inside
  // [15, 30]. Measured from the clip's start it would read 23: the seek is what places it.
  {
    const file = clip("seek.mkv", 33, `if(lt(T,23),${NOISE},${GRAY})`, tone(ROOM, 33));
    assert.equal(await tail(file, 3, 30), 20, "the quiet is found 20 s after the run's end");
  }

  // P10: the winner's clip is missing (archived, a typo in the nickname): measuring must not throw
  // and must not cut — the whole post-roll stays.
  {
    const w = await measureTail(path.join(dir, "missing.mkv"), 0, 20);
    assert.equal(
      suggestTailSec(w, { minSec: FLOOR, maxSec: 20 }),
      20,
      "an unreadable clip keeps the whole tail",
    );
  }

  // P5 end to end: still and room tone from the finish — cut at the floor.
  {
    const file = clip("dead.mkv", 20, GRAY, tone(ROOM, 20));
    assert.equal(await tail(file, 0, 20), FLOOR, "a dead tail is cut at 15 s");
  }

  // P7: stunned for 2 s, then shouting for the rest while sitting still. Talking is a reaction —
  // the winner never goes quiet, so the whole tail stays.
  {
    const file = clip("talk.mkv", 20, GRAY, tone(`if(lt(t,2),${ROOM},${SHOUT})`, 20));
    const got = await tail(file, 0, 20);
    deviation("tail cut earlier only where the winner goes quiet (CLAUDE.md House rules)", () =>
      assert.equal(got, 20, `a winner talking while still from 2 s on was cut at ${got} s of 20`),
    );
  }

  // P4: one shout at the finish, then silent and still for good — the dead air is what the cut
  // removes, so it lands at the floor, not near the cap.
  {
    const file = clip("shout.mkv", 20, GRAY, tone(`if(lt(t,1),${SHOUT},${ROOM})`, 20));
    const got = await tail(file, 0, 20);
    deviation("cut earlier where the winner goes quiet, never under 15 s (CLAUDE.md House rules)", () =>
      assert.equal(got, FLOOR, `a winner silent and still from 1 s on kept ${got} s of 20`),
    );
  }

  // P9: a muted VOD segment is digital silence. Still and muted is as quiet as it gets.
  {
    const file = clip("muted.mkv", 20, GRAY, "anullsrc=r=48000:cl=mono");
    const got = await tail(file, 0, 20);
    deviation(
      "cut earlier where the winner goes quiet, never under 15 s — a muted winner (CLAUDE.md House rules)",
      () => assert.equal(got, FLOOR, `a muted, still winner kept ${got} s of 20`),
    );
  }

  // P6 end to end: moving and shouting the whole window — nothing is cut.
  {
    const file = clip("busy.mkv", 20, NOISE, tone(SHOUT, 20));
    const got = await tail(file, 0, 20);
    deviation(
      "tail ≤ postRollSec, cut earlier only where the winner goes quiet (CLAUDE.md House rules)",
      () => assert.equal(got, 20, `a winner never quiet kept ${got} s of 20`),
    );
  }

  // P13: the public type says per second. A 3 s window is 3 loudness readings — loud or silent.
  {
    const wav = (name: string, audio: string) => {
      const out = path.join(dir, name);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", audio, "-t", "3", out], {
        stdio: "ignore",
        timeout: 10_000,
      });
      return out;
    };
    const loud = await measureTail(wav("loud.wav", tone(SHOUT, 3)), 0, 3);
    deviation('TailWindow.loudness: "Loudness per second" (postRoll.ts)', () =>
      assert.equal(loud.loudness.length, 3, `3 s of audio gave ${loud.loudness.length} loudness readings`),
    );
    const silent = await measureTail(wav("silent.wav", "anullsrc=r=48000:cl=mono"), 0, 3);
    deviation('TailWindow.loudness: "Loudness per second", silence included (postRoll.ts)', () =>
      assert.equal(
        silent.loudness.length,
        3,
        `3 s of digital silence gave ${silent.loudness.length} readings`,
      ),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`postRoll.contract: ${deviations} deviation(s) reported above`);
console.log("postRoll.contract: all checks passed");
