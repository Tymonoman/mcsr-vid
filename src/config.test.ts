import assert from "node:assert/strict";
import { validateOverrides } from "./config.js";

// A hand-edited mcsr-vid.config.json with the wrong type must fail at load, naming the key,
// rather than flowing into slot arithmetic or the Remotion renderer as a string.
assert.throws(() => validateOverrides({ renderConcurrency: "4" }), /renderConcurrency/);
assert.throws(() => validateOverrides({ suggestCloseSlots: "8" }), /suggestCloseSlots/);
assert.throws(() => validateOverrides({ overlayFps: Number.NaN }), /overlayFps/);
assert.throws(() => validateOverrides({ mediaDir: 5 }), /mediaDir/);
// An hour outside the clock would not fail — setUTCHours(25) quietly means 01:00 tomorrow.
assert.throws(() => validateOverrides({ nightlyRenderHourUtc: 24 }), /nightlyRenderHourUtc.*0-23/);
assert.throws(() => validateOverrides({ nightlyRenderHourUtc: -1 }), /nightlyRenderHourUtc/);
assert.throws(() => validateOverrides({ nightlyRenderHourUtc: 3.5 }), /nightlyRenderHourUtc/);

// Typos are worth catching too — a misspelled key would otherwise be silently ignored.
assert.throws(() => validateOverrides({ mediaDirr: "media" }), /unknown key/);
assert.throws(() => validateOverrides({ suggestWeights: { closeMargn: 3 } }), /unknown suggestWeights key/);
assert.throws(() => validateOverrides({ suggestWeights: [] }), /suggestWeights/);

// Legitimate overrides pass, including the one key that is a number *or* null.
assert.doesNotThrow(() => validateOverrides({ renderConcurrency: 4 }));
assert.doesNotThrow(() => validateOverrides({ renderConcurrency: null }));
// And the one that is an argv array or null: a bare string would be spawned as a binary named
// "agy -p {prompt}".
assert.doesNotThrow(() => validateOverrides({ reasonerCommand: null }));
assert.doesNotThrow(() => validateOverrides({ reasonerCommand: ["agy", "-p", "{prompt}"] }));
assert.throws(() => validateOverrides({ reasonerCommand: "agy -p {prompt}" }), /reasonerCommand/);
assert.throws(() => validateOverrides({ reasonerCommand: ["agy", 1] }), /reasonerCommand/);
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: 0 }));
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: 23 }));
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: null }));
assert.throws(() => validateOverrides({ publishHourUtc: 24 }), /publishHourUtc.*0-23/);
assert.throws(
  () => validateOverrides({ publishHourUtc: null }),
  /publishHourUtc/,
  "the publish hour is not optional",
);
assert.doesNotThrow(() => validateOverrides({ publishHourUtc: 19 }));
assert.doesNotThrow(() => validateOverrides({ mediaDir: "/tmp/media", overlayFps: 60 }));
assert.doesNotThrow(() =>
  validateOverrides({ pullSource: "homelab@actimel:/home/homelab/mcsr-media", pullDest: "~/Replayoffs" }),
);
assert.throws(() => validateOverrides({ pullSource: true }), /pullSource/);
assert.doesNotThrow(() => validateOverrides({ suggestWeights: { closeMargin: 4 } }));
// Pose pairs are two names and nothing else: the per-pair `hook` flag is gone (every pair now
// renders a hooked twin), and a config still carrying it would be quietly ignored.
assert.doesNotThrow(() => validateOverrides({ thumbnailVariants: [{ left: "walking", right: "crossed" }] }));
assert.throws(
  () => validateOverrides({ thumbnailVariants: [{ left: "marching", right: "crouching", hook: false }] }),
  /thumbnailVariants/,
);
assert.throws(() => validateOverrides({ thumbnailVariants: [] }), /thumbnailVariants/);
assert.throws(() => validateOverrides({ thumbnailVariants: [{ left: "walking" }] }), /thumbnailVariants/);
assert.throws(() => validateOverrides({ thumbnailVariants: "walking-crossed" }), /thumbnailVariants/);
assert.doesNotThrow(() => validateOverrides({}));
// The teaser's start is nullable (off), its length is not — same rule as the mid-race line's.
assert.doesNotThrow(() => validateOverrides({ teaserAtSec: null, teaserSec: 5 }));
assert.doesNotThrow(() => validateOverrides({ teaserAtSec: 10 }));
assert.throws(() => validateOverrides({ teaserAtSec: -1 }), /teaserAtSec/);
assert.throws(() => validateOverrides({ teaserAtSec: "10" }), /teaserAtSec/);
assert.throws(() => validateOverrides({ teaserSec: null }), /teaserSec/);

console.log("config: all checks passed");
