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
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: 0 }));
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: 23 }));
assert.doesNotThrow(() => validateOverrides({ nightlyRenderHourUtc: null }));
assert.doesNotThrow(() => validateOverrides({ mediaDir: "/tmp/media", overlayFps: 60 }));
assert.doesNotThrow(() => validateOverrides({ suggestWeights: { closeMargin: 4 } }));
assert.doesNotThrow(() => validateOverrides({}));

console.log("config: all checks passed");
