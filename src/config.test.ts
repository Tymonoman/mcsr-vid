import assert from "node:assert/strict";
import { validateOverrides } from "./config.js";

// A hand-edited mcsr-vid.config.json with the wrong type must fail at load, naming the key,
// rather than flowing into slot arithmetic or the Remotion renderer as a string.
assert.throws(() => validateOverrides({ renderConcurrency: "4" }), /renderConcurrency/);
assert.throws(() => validateOverrides({ suggestCloseSlots: "8" }), /suggestCloseSlots/);
assert.throws(() => validateOverrides({ overlayFps: Number.NaN }), /overlayFps/);
assert.throws(() => validateOverrides({ mediaDir: 5 }), /mediaDir/);

// Typos are worth catching too — a misspelled key would otherwise be silently ignored.
assert.throws(() => validateOverrides({ mediaDirr: "media" }), /unknown key/);
assert.throws(() => validateOverrides({ suggestWeights: { closeMargn: 3 } }), /unknown suggestWeights key/);
assert.throws(() => validateOverrides({ suggestWeights: [] }), /suggestWeights/);

// Legitimate overrides pass, including the one key that is a number *or* null.
assert.doesNotThrow(() => validateOverrides({ renderConcurrency: 4 }));
assert.doesNotThrow(() => validateOverrides({ renderConcurrency: null }));
assert.doesNotThrow(() => validateOverrides({ mediaDir: "/tmp/media", overlayFps: 60 }));
assert.doesNotThrow(() => validateOverrides({ suggestWeights: { closeMargin: 4 } }));
assert.doesNotThrow(() => validateOverrides({}));

console.log("config: all checks passed");
