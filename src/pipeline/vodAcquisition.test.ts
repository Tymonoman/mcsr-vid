import assert from "node:assert/strict";
import { parseYtDlpPercent } from "./vodAcquisition.js";

// Samples derived directly from yt-dlp's installed source (downloader/common.py):
// mid-progress uses format_percent() -> f'{percent:>5.1f}%'; the finished line uses a literal '100%%'
// (no decimal), both behind the '[download] %(progress._default_template)s' prefix.
assert.equal(parseYtDlpPercent("[download]  45.2% of   10.00MiB at    1.23MiB/s ETA 00:05"), 45.2);
assert.equal(parseYtDlpPercent("[download] 100% of   10.00MiB in 00:08"), 100);
assert.equal(parseYtDlpPercent('[Merger] Merging formats into "output.mp4"'), null);

console.log("all checks passed");

// --- One definition of where a match starts inside its VOD -------------------------------------
// `date` is the completion timestamp, so match start is `date - vod.startsAt - run`.
{
  const { matchStartIntoVodSec } = await import("./vodAcquisition.js");
  const match = { date: 10_000, result: { time: 480_000 } } as unknown as import("../api/types.js").MatchInfo;
  assert.equal(matchStartIntoVodSec(match, { startsAt: 4_000 }), 10_000 - 4_000 - 480, "end minus the run");
  const noResult = { date: 10_000, result: { time: 0 } } as unknown as import("../api/types.js").MatchInfo;
  assert.equal(
    matchStartIntoVodSec(noResult, { startsAt: 4_000 }),
    10_000 - 4_000 - 900,
    "no result: the default run length, as the download path assumes",
  );
  console.log("OK: matchStartIntoVodSec");
}

// --- Where the match sits inside the downloaded clip --------------------------------------------
// The window opens PRE_ROLL_SEC before the start but never before the VOD's own head, so a clip
// already on disk is searched where the download put the match, not at a flat 150 s.
{
  const { matchOffsetIntoClipSec, PRE_ROLL_SEC } = await import("./vodAcquisition.js");
  const match = { date: 10_000, result: { time: 480_000 } } as unknown as import("../api/types.js").MatchInfo;
  const liveFor = (sec: number) => ({ startsAt: 10_000 - 480 - sec });
  assert.equal(matchOffsetIntoClipSec(match, liveFor(600)), PRE_ROLL_SEC, "a long stream: the full pre-roll");
  assert.equal(
    matchOffsetIntoClipSec(match, liveFor(60)),
    60,
    "live 60 s before the match: clamped at the head",
  );
  assert.equal(matchOffsetIntoClipSec(match, liveFor(-20)), -20, "a VOD that began after the match");
  console.log("OK: matchOffsetIntoClipSec");
}
