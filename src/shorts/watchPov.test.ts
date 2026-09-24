// Self-check for watchPov.ts against a fake watch.py: a python script that records its argv and
// prints what the real one prints (the markdown report, byte for byte in shape), in a temp media
// dir with stand-in clips. Pinned: the arguments (the match window from sync.json, the fixed
// sampler, --no-whisper without a key), the stills on the match clock half an interval after
// their index — measured on real footage, the parse of the real output below — the transcript on
// the match clock, the cache and what breaks it, and every failure dropping only that POV.
// Run: npx tsx src/shorts/watchPov.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir, validateOverrides } from "../config.js";
import { parseWatchOutput, transcriptProblem, watchDir, watchFailure, watchPovs } from "./watchPov.js";

const tmp = mkdtempSync(path.join(tmpdir(), "watchpov-"));
config.mediaDir = path.join(tmp, "media");
// No Whisper key from the machine running the test: its env and its ~/.config/watch/.env.
process.env.HOME = tmp;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;

// --- The parse, on watch.py's real output (13473906, Feinberg's clip, 23 Sept 2026; three of its
// 100 frame lines). Frame 50 showed the streamer's timer at 4:25.007: slot i is (i + ½)/fps in.
{
  const real = `
# watch: video report

- **Source:** /media/13473906/Feinberg.mp4
- **Title:** Feinberg.mp4
- **Duration:** 11:52 (712.5s)
- **Focus range:** 02:29 → 11:24 (535.4s)
- **Resolution:** 1920x1080 (h264)
- **Frames:** 100 @ 0.187 fps, focused mode (budget 100, max 100)
- **Frame size:** 512px wide
- **Transcript:** none available

## Frames

Frames live at: \`/w/frames\`

**Read each frame path below with the Read tool to view the image.** Frames are in chronological order; \`t=MM:SS\` is the absolute timestamp in the source video.

- \`/w/frames/frame_0001.jpg\` (t=02:29)
${Array.from({ length: 48 }, (_, i) => `- \`/w/frames/frame_${String(i + 2).padStart(4, "0")}.jpg\` (t=02:34)`).join("\n")}
- \`/w/frames/frame_0050.jpg\` (t=06:51)

## Transcript

_No transcript available — proceed with frames only. Captions were missing and the Whisper fallback was unavailable (no API key set, or \`--no-whisper\` was used). Run \`python3 /x/setup.py\` to enable Whisper, then re-run._

---
_Report (ingest-ready): \`/w/report.md\`_
`;
  const parsed = parseWatchOutput(real, {
    side: "left",
    offsetSec: 148.517,
    fps: 100 / 535.383,
    endSec: 535.4,
  });
  assert.equal(parsed.frames.length, 50);
  assert.deepEqual(parsed.frames[0], { path: "/w/frames/frame_0001.jpg", matchSec: 2.7 });
  assert.deepEqual(parsed.frames[49], { path: "/w/frames/frame_0050.jpg", matchSec: 265 });
  assert.equal(parsed.transcript, null);
  assert.deepEqual(parsed.notes, [
    "Frames: 100 @ 0.187 fps, focused mode (budget 100, max 100)",
    "Transcript: none available",
  ]);
  console.log("OK: watch.py's real report parses, each still half an interval after its index");
}

// --- The fake watch.py ------------------------------------------------------------------------
const calls = path.join(tmp, "calls.jsonl");
const fake = path.join(tmp, "watch.py");
writeFileSync(
  fake,
  `import json, os, sys
args = sys.argv[1:]
with open(${JSON.stringify(calls)}, "a") as f:
    f.write(json.dumps(args) + "\\n")
clip = args[0]
opt = lambda name: args[args.index(name) + 1]
if os.environ.get("FAKE_WATCH_FAIL") and os.environ["FAKE_WATCH_FAIL"] in clip:
    print("[watch] ffmpeg frame extraction failed: boom", file=sys.stderr)
    sys.exit(1)
out, start, fps = opt("--out-dir"), float(opt("--start")), float(opt("--fps"))
os.makedirs(out + "/frames", exist_ok=True)
mmss = lambda s: f"{int(round(s)) // 60:02d}:{int(round(s)) % 60:02d}"
whisper = "--no-whisper" not in args
fail = os.environ.get("FAKE_WHISPER_FAIL")
if whisper and fail:
    print(f"[watch] whisper fallback failed: {fail}", file=sys.stderr)
    whisper = False
print("# watch: video report\\n")
print(f"- **Frames:** 4 @ {fps:.3f} fps, focused mode (budget 100, max 100)")
print("- **Transcript:** " + ("3 segments in range (via whisper (groq))" if whisper else "none available"))
print("\\n## Frames\\n")
for i in range(4):
    p = f"{out}/frames/frame_{i + 1:04d}.jpg"
    open(p, "wb").write(b"jpeg")
    print(f"- \`{p}\` (t={mmss(start + i / fps)})")
print("\\n## Transcript\\n")
if whisper:
    print("_Source: whisper (groq)._\\n\\n\`\`\`")
    for t, text in ((start + 9, "no way he blind travelled"), (start + 579, "GG go next"), (start + 700, "after it")):
        print(f"[{int(t) // 60:02d}:{int(t) % 60:02d}] {text}")
    print("\`\`\`")
else:
    print("_No transcript available — proceed with frames only._")
`,
);
config.watchScript = fake;
const callCount = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0);
const lastCall = (): string[] => JSON.parse(readFileSync(calls, "utf8").trim().split("\n").pop()!);

// 12730175: edcr (left) vs doogile (right), run 10:22.4.
const match = {
  ...(JSON.parse(
    readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
  ) as MatchInfo),
  changes: [],
};
const dir = matchDir(match.id);
mkdirSync(dir, { recursive: true });
const past = new Date(Date.now() - 60_000);
for (const nick of ["edcr", "doogile"]) {
  writeFileSync(path.join(dir, `${nick}.mp4`), "not really a clip");
  utimesSync(path.join(dir, `${nick}.mp4`), past, past);
}
const sync = (left: number, right: number) =>
  writeFileSync(
    path.join(dir, "sync.json"),
    JSON.stringify({ left, right, confidence: 1, detail: "", source: "countdown" }),
  );
sync(140.5, 150.25);
const lines: string[] = [];
const levels: Array<string | undefined> = [];
const log = (l: string, extra?: { level?: string }) => {
  lines.push(l);
  levels.push(extra?.level);
};
const endSec = match.result.time / 1000 + 3;
const fps = 100 / endSec;

{
  const povs = await watchPovs(match, { log });
  assert.equal(callCount(), 2);
  assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").split("\n")[0]!), [
    path.join(dir, "edcr.mp4"),
    "--start",
    "140.500",
    "--end",
    (140.5 + endSec).toFixed(3),
    "--fps",
    String(fps),
    "--max-frames",
    "100",
    "--resolution",
    "512",
    "--no-hook-microscope",
    "--out-dir",
    watchDir(dir, "left"),
    "--no-whisper",
  ]);
  assert.equal(lastCall()[2], "150.250", "the right clip's own offset");
  assert.deepEqual(
    povs.map((p) => p.side),
    ["left", "right"],
  );
  assert.deepEqual(povs[0]!.frames, [
    { path: path.join(watchDir(dir, "left"), "frames/frame_0001.jpg"), matchSec: 3.1 },
    { path: path.join(watchDir(dir, "left"), "frames/frame_0002.jpg"), matchSec: 9.4 },
    { path: path.join(watchDir(dir, "left"), "frames/frame_0003.jpg"), matchSec: 15.6 },
    { path: path.join(watchDir(dir, "left"), "frames/frame_0004.jpg"), matchSec: 21.9 },
  ]);
  assert.equal(povs[0]!.transcript, null);
  assert.deepEqual(povs[0]!.notes, [
    "Frames: 4 @ 0.160 fps, focused mode (budget 100, max 100)",
    "Transcript: none available",
    "--no-whisper: no GROQ_API_KEY or OPENAI_API_KEY",
  ]);
  assert.ok(existsSync(path.join(watchDir(dir, "right"), "watch.json")));
  console.log("OK: both clips are watched over the match window, the stills on the match clock");

  // Newer than the clip, same arguments: kept.
  assert.deepEqual(await watchPovs(match, { log }), povs);
  assert.equal(callCount(), 2, "cached, watch.py not run again");
  assert.ok(lines.includes("/watch on edcr's stream is up to date — kept (4 stills)"));
  // A sync fix moves the window: that clip is watched again, the other is kept.
  sync(141, 150.25);
  await watchPovs(match, { log });
  assert.deepEqual([callCount(), lastCall()[0]], [3, path.join(dir, "edcr.mp4")]);
  // A new clip is watched again.
  utimesSync(path.join(dir, "doogile.mp4"), new Date(), new Date(Date.now() + 5000));
  await watchPovs(match, { log });
  assert.deepEqual([callCount(), lastCall()[0]], [4, path.join(dir, "doogile.mp4")]);
  console.log("OK: the cache holds until the clip or its window changes");
}

{
  // A Whisper key: watch.py transcribes, and the lines land on the match clock inside the run.
  process.env.GROQ_API_KEY = "gsk_test";
  const povs = await watchPovs(match, { log });
  assert.ok(!lastCall().includes("--no-whisper"));
  assert.deepEqual(povs[0]!.transcript, [
    { matchSec: 9, text: "no way he blind travelled" },
    { matchSec: 579, text: "GG go next" },
  ]);
  assert.ok(lines.at(-1)!.startsWith("/watch on doogile: 4 stills, transcript: 2 lines ("));

  // Groq refuses the key: watch.py goes on with the stills (exit 0), the reason is in its stderr.
  // Not cached — the next pick runs /watch again, once the key is fixed.
  process.env.FAKE_WHISPER_FAIL = "Whisper request failed: HTTP Error 401: Unauthorized — invalid_api_key";
  sync(142, 150.25);
  const refused = await watchPovs(match, { log });
  assert.equal(refused[0]!.transcript, null);
  assert.ok(
    refused[0]!.notes.some((n) => /Groq refused the key \(401\).*GROQ_API_KEY in \/app\/\.env/.test(n)),
  );
  const refusedLine = lines.findIndex((l) =>
    /^\/watch on edcr: 4 stills, no transcript — Groq refused the key \(401\)/.test(l),
  );
  assert.ok(refusedLine >= 0 && levels[refusedLine] === "warn", "a warning, with the fix");
  const calledOnce = callCount();
  await watchPovs(match, { log });
  assert.equal(callCount(), calledOnce + 2, "a transcript that failed is not kept: both run again");

  // Rate-limited: the same, with its own words.
  process.env.FAKE_WHISPER_FAIL = "Whisper request failed: HTTP Error 429: Too Many Requests";
  await watchPovs(match, { log });
  assert.ok(lines.some((l) => /no transcript — Groq rate-limited the transcription \(429\)/.test(l)));

  delete process.env.FAKE_WHISPER_FAIL;
  delete process.env.GROQ_API_KEY;
  console.log("OK: with a key the transcript is kept, on the match clock, past the run dropped");
  console.log("OK: Groq's 401 and 429 are named with their fix, and not cached");
}

{
  // The failures that are the box's, and the transcript's reasons, as the operator reads them.
  assert.equal(
    watchFailure(127, "nice: 'python3': No such file or directory"),
    "/watch failed: python3 is not installed in this container — install it (or fix the path), then try again",
  );
  assert.equal(watchFailure(127, ""), "/watch failed: python3 is not installed in this container");
  assert.match(watchFailure(1, "OSError: [Errno 28] No space left on device"), /the disk is full/);
  assert.match(watchFailure(null, "", false, "SIGKILL"), /out of memory \(the container's 4 GB cap/);
  assert.equal(watchFailure(null, "", true), "watch.py ran over 15 min and was stopped");
  assert.match(
    watchFailure(1, "[watch] x\nSystemExit: ffmpeg is not installed. Install with: brew install ffmpeg"),
    /ffmpeg is not installed/,
  );
  assert.equal(transcriptProblem("", true, 3), null, "a transcript is no problem");
  assert.match(transcriptProblem("", true, 0)!.text, /heard no speech/);
  assert.match(transcriptProblem("", false, 0)!.text, /no GROQ_API_KEY/);
  assert.deepEqual(
    transcriptProblem(
      "[watch] whisper fallback failed: ffmpeg produced no audio — video may have no audio track",
      true,
      0,
    ),
    { text: "no transcript — the clip has no audio track", transient: false },
  );
  console.log("OK: python3 missing, the disk full, the memory cap, a timeout — each named");
}

{
  // A failing POV costs that POV only.
  rmSync(watchDir(dir, "right"), { recursive: true });
  process.env.FAKE_WATCH_FAIL = "doogile";
  const povs = await watchPovs(match, { log });
  delete process.env.FAKE_WATCH_FAIL;
  assert.deepEqual(
    povs.map((p) => p.side),
    ["left"],
  );
  assert.ok(
    lines.includes(
      "/watch failed on doogile's stream: watch.py exited 1: [watch] ffmpeg frame extraction failed: boom — the pick goes on without it",
    ),
  );
  rmSync(path.join(dir, "doogile.mp4"));
  assert.equal((await watchPovs(match, { log })).length, 1);
  assert.ok(
    lines.includes(
      `/watch skipped on the right POV: no clip on disk (${path.join(dir, "doogile.mp4")}) — npm run download-vods -- ${match.id} fetches it while the VOD lasts`,
    ),
  );

  const before = callCount();
  config.watchScript = path.join(tmp, "nowhere/watch.py");
  assert.deepEqual(await watchPovs(match, { log }), []);
  assert.ok(
    lines.includes(
      `/watch is not installed (${config.watchScript} not found) — the model picks from the video alone; reinstall the claude-watch plugin or set watchScript`,
    ),
  );
  config.watchScript = null;
  assert.deepEqual(await watchPovs(match, { log }), []);
  assert.equal(callCount(), before);

  const controller = new AbortController();
  controller.abort();
  config.watchScript = fake;
  rmSync(watchDir(dir, "left"), { recursive: true });
  const calledBefore = callCount();
  await assert.rejects(watchPovs(match, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(callCount(), calledBefore, "nothing is started after an abort");
  console.log(
    "OK: a failure, a missing clip or script, null — each drops /watch, never the pick; abort rejects",
  );
}

assert.doesNotThrow(() => validateOverrides({ watchScript: null }));
assert.doesNotThrow(() => validateOverrides({ watchScript: "/x/watch.py" }));
assert.throws(() => validateOverrides({ watchScript: "" }), /watchScript/);
assert.throws(() => validateOverrides({ watchScript: 3 }), /watchScript/);

rmSync(tmp, { recursive: true, force: true });
console.log("watchPov: all checks passed");
