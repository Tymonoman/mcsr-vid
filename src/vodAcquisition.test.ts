import assert from "node:assert/strict";
import { parseYtDlpPercent } from "./vodAcquisition.js";

// Samples derived directly from yt-dlp's installed source (downloader/common.py):
// mid-progress uses format_percent() -> f'{percent:>5.1f}%'; the finished line uses a literal '100%%'
// (no decimal), both behind the '[download] %(progress._default_template)s' prefix.
assert.equal(parseYtDlpPercent("[download]  45.2% of   10.00MiB at    1.23MiB/s ETA 00:05"), 45.2);
assert.equal(parseYtDlpPercent("[download] 100% of   10.00MiB in 00:08"), 100);
assert.equal(parseYtDlpPercent('[Merger] Merging formats into "output.mp4"'), null);

console.log("all checks passed");
