import assert from "node:assert/strict";
import { suggestTailSec } from "./postRoll.js";

const opts = { minSec: 15, maxSec: 60 };
const flat = (value: number, n: number) => Array<number>(n).fill(value);

{
  // 25s of celebration, then the streamer goes quiet and still. Cut at the start of the silence.
  const loudness = [...flat(-12, 25), ...flat(-70, 35)];
  const motion = [...flat(40, 25), ...flat(0.3, 35)];
  assert.equal(suggestTailSec({ loudness, motion }, opts), 25);
}
{
  // Silent but moving — rewatching the finish without commentary. Still a reaction; keep it.
  const loudness = flat(-70, 60);
  const motion = [...flat(40, 30), ...flat(0.3, 30)];
  assert.equal(suggestTailSec({ loudness, motion }, opts), 30);
}
{
  // Talking but sitting still. Also a reaction.
  const loudness = [...flat(-12, 30), ...flat(-70, 30)];
  const motion = flat(0.3, 60);
  assert.equal(suggestTailSec({ loudness, motion }, opts), 30);
}
{
  // Never quiets down: keep the whole allowance, never more.
  const long = suggestTailSec({ loudness: flat(-12, 60), motion: flat(40, 60) }, opts);
  assert.equal(long, 60);
}
{
  // Dead the instant the run ends. The floor still applies — cutting on the dragon's death frame
  // reads as a broken file, not an ending.
  assert.equal(suggestTailSec({ loudness: flat(-70, 60), motion: flat(0.3, 60) }, opts), 15);
}
{
  // A brief lull mid-celebration must not end the tail.
  const loudness = [...flat(-12, 20), ...flat(-70, 3), ...flat(-12, 20), ...flat(-70, 17)];
  const motion = [...flat(40, 20), ...flat(0.3, 3), ...flat(40, 20), ...flat(0.3, 17)];
  assert.equal(suggestTailSec({ loudness, motion }, opts), 43, "a 3s pause is not the end");
}
{
  // Constant activity from start to finish. Normalising each series to its own range made this
  // read as constant *silence* and cut at the floor — the units are absolute, so do not rescale.
  assert.equal(suggestTailSec({ loudness: flat(-30, 60), motion: flat(5, 60) }, opts), 60);
}
{
  // Room tone below the silence gate, and a frame that never changes: nothing is happening.
  assert.equal(suggestTailSec({ loudness: flat(-58, 60), motion: flat(1.1, 60) }, opts), 15);
}
{
  // No measurements at all (audio-less clip, probe failed): keep the configured maximum rather
  // than silently truncating someone's video.
  assert.equal(suggestTailSec({ loudness: [], motion: [] }, opts), 60);
}

console.log("postRoll: all checks passed");
