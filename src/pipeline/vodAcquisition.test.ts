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

// postRollSec is a Settings key and the dashboard renders in-process, so it is read per call. A
// module-level copy kept the boot-time value in the VOD window and the overlay's length until a restart.
{
  const { readFileSync } = await import("node:fs");
  assert.ok(!("POST_ROLL_SEC" in (await import("./vodAcquisition.js"))), "no captured post-roll export");
  for (const file of ["vodAcquisition.ts", "overlayRender.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(src.includes("config.postRollSec"), `${file} reads the live setting`);
    assert.ok(
      !/^(export )?const \w+\s*=\s*config\.postRollSec\b/m.test(src),
      `${file} must not capture it at import`,
    );
  }
  console.log("OK: postRollSec read per call");
}
