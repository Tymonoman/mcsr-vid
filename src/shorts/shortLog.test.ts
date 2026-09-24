// Self-check for shortLog.ts in a temp media dir: the per-match log (append, read the last N, a
// torn line skipped, the trim once it passes a megabyte, no directory no file), the activity
// registry (a step's live line follows its info lines, not its warnings; progress is a percent
// and four log lines; the newest step is the match's), and the box's own failures in words.
// Run: npx tsx src/shorts/shortLog.test.ts
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  activityOf,
  activityProgress,
  boxFailure,
  endActivity,
  readShortLog,
  runningActivities,
  shortLog,
  shortLogFile,
  startActivity,
  stepActivity,
} from "./shortLog.js";

const media = mkdtempSync(path.join(tmpdir(), "shortlog-"));
config.mediaDir = media;
const A = 13_100_001;
const dir = path.join(media, String(A));
mkdirSync(dir);

try {
  {
    shortLog(A, "chain", "hooks saved");
    shortLog(A, "pick", "answer in 93 s", { detail: '{"startSec": 505}' });
    shortLog(A, "pick", "rejected", { level: "warn", detail: "x".repeat(10_000) });
    const log = readShortLog(A);
    assert.deepEqual(
      log.map((l) => [l.step, l.level, l.text]),
      [
        ["chain", "info", "hooks saved"],
        ["pick", "info", "answer in 93 s"],
        ["pick", "warn", "rejected"],
      ],
    );
    assert.equal(log[1]!.detail, '{"startSec": 505}');
    assert.ok(
      log[2]!.detail!.length < 4100 && log[2]!.detail!.includes("\n…\n"),
      "a long detail keeps its ends",
    );
    assert.equal(log[0]!.detail, undefined, "no detail, no field");
    assert.deepEqual(
      readShortLog(A, 1).map((l) => l.text),
      ["rejected"],
      "the last N, oldest first",
    );
    appendFileSync(shortLogFile(dir, A), '{"torn": \n');
    shortLog(A, "chain", "after the tear");
    assert.equal(readShortLog(A).at(-1)!.text, "after the tear", "a torn line is skipped, the rest reads");
    // A match never started gets no directory and no log.
    shortLog(99, "pick", "nothing");
    assert.ok(!existsSync(path.join(media, "99")));
    assert.deepEqual(readShortLog(99), []);
    console.log("OK: lines append, read back newest last, a long detail is clipped, a torn line skipped");
  }

  {
    // Past a megabyte, trimmed to the last 500 lines (and half the budget): the newest kept.
    for (let i = 0; i < 2500; i++) shortLog(A, "render", `line ${i}`, { detail: "d".repeat(400) });
    const size = statSync(shortLogFile(dir, A)).size;
    assert.ok(size <= 1024 * 1024, `capped: ${size} bytes`);
    const lines = readFileSync(shortLogFile(dir, A), "utf8").trim().split("\n");
    assert.ok(lines.length <= 2500 && lines.length >= 500, `${lines.length} lines`);
    assert.equal(readShortLog(A, 1)[0]!.text, "line 2499", "the newest line survives the trim");
    console.log("OK: the log is trimmed to its last lines once it passes a megabyte");
  }

  {
    rmSync(shortLogFile(dir, A));
    startActivity(A, "pick", "starting the pick");
    assert.equal(activityOf(A)?.line, "starting the pick");
    const since = activityOf(A)!.since;
    await new Promise((r) => setTimeout(r, 5));
    shortLog(A, "pick", "running /watch on edcr's stream");
    assert.equal(activityOf(A)?.line, "running /watch on edcr's stream", "an info line is the live line");
    assert.ok(activityOf(A)!.since > since, "and restarts the clock");
    shortLog(A, "pick", "/watch failed", { level: "warn" });
    assert.equal(activityOf(A)?.line, "running /watch on edcr's stream", "a warning is not what it is doing");
    shortLog(A, "render", "a render line with no render running");
    assert.equal(stepActivity(A, "render"), undefined);

    startActivity(A, "upload-video", "uploading the long-form (2100 MB, private)");
    for (const pct of [3, 10, 26, 40, 51, 77, 99, 100]) activityProgress(A, "upload-video", pct);
    assert.deepEqual(activityOf(A), {
      step: "upload-video",
      line: "uploading the long-form (2100 MB, private)",
      since: activityOf(A)!.since,
      percent: 100,
    });
    assert.deepEqual(
      readShortLog(A)
        .filter((l) => l.step === "upload-video")
        .map((l) => l.text),
      [
        "uploading the long-form (2100 MB, private)",
        "uploading the long-form (2100 MB, private) · 26%",
        "uploading the long-form (2100 MB, private) · 51%",
        "uploading the long-form (2100 MB, private) · 77%",
      ],
      "progress: a line a quarter, the live line unchanged",
    );
    activityProgress(A, "upload-video", 5, "a new phase");
    assert.equal(activityOf(A)?.line, "a new phase");

    const B = 13_100_002;
    mkdirSync(path.join(media, String(B)));
    startActivity(B, "render", "cutting the Short");
    assert.deepEqual(
      runningActivities().map((r) => [r.matchId, r.step]),
      [
        [A, "pick"],
        [A, "upload-video"],
        [B, "render"],
      ],
      "the box's activity, oldest first",
    );
    endActivity(A, "upload-video");
    assert.equal(activityOf(A)?.step, "pick", "the step still running is the match's again");
    endActivity(A, "pick");
    endActivity(B, "render");
    assert.equal(activityOf(A), undefined);
    assert.deepEqual(runningActivities(), []);
    console.log("OK: the live line follows a step's info lines; progress is a percent and a line a quarter");
  }

  {
    assert.match(
      boxFailure("the render", "Error: ENOSPC: no space left on device, write")!,
      /^the render failed: the disk is full/,
    );
    assert.match(boxFailure("the render", "[out#0] No space left on device")!, /the disk is full/);
    assert.match(
      boxFailure("the render", "", { code: 137 })!,
      /^the render was killed — out of memory \(the container's 4 GB cap, exit 137\)/,
    );
    assert.match(boxFailure("the render", "", { signal: "SIGKILL" })!, /out of memory/);
    assert.match(boxFailure("the render", "short render exited with code 137")!, /out of memory/);
    assert.match(
      boxFailure("the proxy", "Error: spawn ffmpeg ENOENT")!,
      /^the proxy failed: ffmpeg is not installed/,
    );
    assert.match(
      boxFailure("/watch", "nice: 'python3': No such file or directory")!,
      /python3 is not installed/,
    );
    assert.match(boxFailure("x", "sh: 1: ffprobe: not found")!, /ffprobe is not installed/);
    assert.equal(
      boxFailure("x", "/media/1/final.mp4: No such file or directory"),
      null,
      "a missing input is not a missing tool",
    );
    assert.equal(boxFailure("x", "MCSR Ranked API /matches/1 -> 404 Not Found"), null);
    assert.equal(boxFailure("x", '{"startSec": 137}'), null, "a number is not an exit code");
    console.log("OK: the disk, the memory cap and a missing tool are named; other text is not");
  }
} finally {
  rmSync(media, { recursive: true, force: true });
}

console.log("shortLog: all checks passed");
