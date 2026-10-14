import assert from "node:assert/strict";
import {
  blockedIn,
  config,
  CTA_REASON_MAX_CHARS,
  DEFAULTS,
  isBlockedPlayer,
  validateOverrides,
} from "./config.js";

// loadConfig() (behind the `config` export) must hand out a copy, never the literal DEFAULTS
// object — otherwise any mutation of the live config (a test's included, suggestSelect.test.ts
// in a worktree with no mcsr-vid.config.json) corrupts the one shared default forever.
assert.notEqual(config, DEFAULTS, "config must not be the DEFAULTS object itself");
{
  const before = DEFAULTS.suggestCloseSlots;
  config.suggestCloseSlots = before + 1;
  assert.equal(DEFAULTS.suggestCloseSlots, before, "mutating config must leave DEFAULTS unchanged");
  config.suggestCloseSlots = before;
}

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
// The series slot is the same kind of hour: a hand-edited 25 rolled into the next day unchecked.
assert.throws(() => validateOverrides({ seriesPublishHourUtc: 24 }), /seriesPublishHourUtc.*0-23/);
assert.throws(() => validateOverrides({ seriesPublishHourUtc: -1 }), /seriesPublishHourUtc/);
assert.throws(() => validateOverrides({ seriesPublishHourUtc: 3.5 }), /seriesPublishHourUtc/);
assert.throws(() => validateOverrides({ seriesPublishHourUtc: null }), /seriesPublishHourUtc/);
assert.doesNotThrow(() => validateOverrides({ seriesPublishHourUtc: 0 }));
assert.doesNotThrow(() => validateOverrides({ seriesPublishHourUtc: 23 }));
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
assert.throws(() => validateOverrides({ teaserSec: -1 }), /teaserSec/);
assert.throws(() => validateOverrides({ teaserAtSec: 3601 }), /teaserAtSec/);
assert.doesNotThrow(() => validateOverrides({ teaserSec: 0 }), "0 s is a valid way to show none");
// Explain the moves ships off (null) and takes seconds when switched on.
assert.equal(DEFAULTS.explainMovesSec, null);
assert.doesNotThrow(() => validateOverrides({ explainMovesSec: null }));
assert.doesNotThrow(() => validateOverrides({ explainMovesSec: 6 }));
assert.throws(() => validateOverrides({ explainMovesSec: -1 }), /explainMovesSec/);
assert.throws(() => validateOverrides({ explainMovesSec: "6" }), /explainMovesSec/);
// Auto-hooks: off (null) by default, whole hours 1-48 when the operator turns it on.
assert.equal(DEFAULTS.autoHooksAfterHours, null);
assert.doesNotThrow(() => validateOverrides({ autoHooksAfterHours: null }));
assert.doesNotThrow(() => validateOverrides({ autoHooksAfterHours: 6 }));
assert.doesNotThrow(() => validateOverrides({ autoHooksAfterHours: 1 }));
assert.doesNotThrow(() => validateOverrides({ autoHooksAfterHours: 48 }));
assert.throws(() => validateOverrides({ autoHooksAfterHours: 0 }), /autoHooksAfterHours/);
assert.throws(() => validateOverrides({ autoHooksAfterHours: 49 }), /autoHooksAfterHours/);
assert.throws(() => validateOverrides({ autoHooksAfterHours: 6.5 }), /autoHooksAfterHours/);
assert.throws(() => validateOverrides({ autoHooksAfterHours: "6" }), /autoHooksAfterHours/);
// The intro card: 7 s by default (today's card), 2-7 allowed (24 Sept 2026 audit, fix #1).
assert.equal(DEFAULTS.introSec, 7);
assert.doesNotThrow(() => validateOverrides({ introSec: 3 }));
assert.doesNotThrow(() => validateOverrides({ introSec: 2 }));
assert.throws(() => validateOverrides({ introSec: 1 }), /introSec/);
assert.throws(() => validateOverrides({ introSec: 8 }), /introSec/);
assert.throws(() => validateOverrides({ introSec: "3" }), /introSec/);
assert.throws(() => validateOverrides({ introSec: null }), /introSec/);
// The favourite players: the roster by default, [] is "no bonus", and the generic typeof check (an
// array default accepts any object) must not let null, a string or a blank name through.
// edcr is not on it: whether he is, is the operator's call, made in the Settings tab.
assert.deepEqual(DEFAULTS.favouritePlayers, [
  "doogile",
  "Feinberg",
  "Infume",
  "Pinne",
  "lowk3y_",
  "silverrruns",
]);
assert.doesNotThrow(() => validateOverrides({ favouritePlayers: [] }));
assert.doesNotThrow(() => validateOverrides({ favouritePlayers: ["edcr", "Feinberg"] }));
assert.throws(() => validateOverrides({ favouritePlayers: null }), /favouritePlayers/);
assert.throws(() => validateOverrides({ favouritePlayers: "edcr, doogile" }), /favouritePlayers/);
assert.throws(() => validateOverrides({ favouritePlayers: { edcr: true } }), /favouritePlayers/);
assert.throws(() => validateOverrides({ favouritePlayers: ["edcr", 7] }), /favouritePlayers/);
assert.throws(() => validateOverrides({ favouritePlayers: ["edcr", "  "] }), /favouritePlayers/);

// The blocklist: same rule as favouritePlayers (an array of nicknames, [] for nobody blocked),
// and on by default for the names the operator named (Aquacorde 2 Oct 2026, BeefSalad 4 Oct 2026).
assert.deepEqual(DEFAULTS.blockedPlayers, ["Aquacorde", "BeefSalad"]);
assert.doesNotThrow(() => validateOverrides({ blockedPlayers: [] }));
assert.doesNotThrow(() => validateOverrides({ blockedPlayers: ["Aquacorde", "someoneElse"] }));
assert.throws(() => validateOverrides({ blockedPlayers: null }), /blockedPlayers/);
assert.throws(() => validateOverrides({ blockedPlayers: "Aquacorde" }), /blockedPlayers/);
assert.throws(() => validateOverrides({ blockedPlayers: { Aquacorde: true } }), /blockedPlayers/);
assert.throws(() => validateOverrides({ blockedPlayers: ["Aquacorde", 7] }), /blockedPlayers/);
assert.throws(() => validateOverrides({ blockedPlayers: ["  "] }), /blockedPlayers/);

// isBlockedPlayer/blockedIn: whole names, any case, read live off config so a Settings save applies
// at once. Saved and restored so this file leaves the default in place for whatever runs after it.
{
  const saved = config.blockedPlayers;
  config.blockedPlayers = ["Aquacorde"];
  assert.equal(isBlockedPlayer("Aquacorde"), true);
  assert.equal(isBlockedPlayer("AQUACORDE"), true, "case is ignored");
  assert.equal(isBlockedPlayer("aquacorde2"), false, "whole names, not prefixes");
  assert.equal(isBlockedPlayer("doogile"), false);
  assert.equal(blockedIn(["doogile", "Aquacorde"]), true, "either side");
  assert.equal(blockedIn(["doogile", "Feinberg"]), false);
  config.blockedPlayers = [];
  assert.equal(isBlockedPlayer("Aquacorde"), false, "an empty list blocks nobody");
  config.blockedPlayers = [" Aquacorde", "BeefSalad "];
  assert.equal(isBlockedPlayer("BeefSalad"), true, "a hand-edited padded entry still blocks");
  assert.equal(isBlockedPlayer("aquacorde"), true);
  assert.equal(isBlockedPlayer(" beefsalad"), true);
  assert.equal(isBlockedPlayer("BeefSalad2"), false, "still whole names");
  assert.equal(isBlockedPlayer("Beef Salad"), false);
  config.blockedPlayers = saved;
  console.log(
    "OK: blockedPlayers validates like favouritePlayers; isBlockedPlayer/blockedIn are case-insensitive",
  );
}
// The pair-repeat window: 3 days by default, whole days 0-30, 0 is off (seriesPairGapDays' own rule).
assert.equal(DEFAULTS.pairRepeatDays, 3);
assert.doesNotThrow(() => validateOverrides({ pairRepeatDays: 0 }));
assert.doesNotThrow(() => validateOverrides({ pairRepeatDays: 30 }));
assert.throws(() => validateOverrides({ pairRepeatDays: 31 }), /pairRepeatDays.*0-30/);
assert.throws(() => validateOverrides({ pairRepeatDays: -1 }), /pairRepeatDays/);
assert.throws(() => validateOverrides({ pairRepeatDays: 2.5 }), /pairRepeatDays/);
assert.throws(() => validateOverrides({ pairRepeatDays: "3" }), /pairRepeatDays/);
assert.throws(() => validateOverrides({ pairRepeatDays: null }), /pairRepeatDays/);
// The known-player follower bar: whole followers, 0 or more (0: every player off the list is known).
assert.equal(DEFAULTS.knownFollowerThreshold, 10_000);
assert.doesNotThrow(() => validateOverrides({ knownFollowerThreshold: 0 }));
assert.doesNotThrow(() => validateOverrides({ knownFollowerThreshold: 250_000 }));
for (const bad of [-1, 2.5, "1000", null]) {
  assert.throws(
    () => validateOverrides({ knownFollowerThreshold: bad }),
    /knownFollowerThreshold.*whole number/,
  );
}
assert.throws(
  () => validateOverrides({ seriesPairGapDays: 31 }),
  /seriesPairGapDays.*0-30/,
  "it shares the rule",
);

// The subscribe cards' reason: one row of the meta column, or empty for the bare card. A second
// row would push the post-roll card's last line out of its plate, so the limit is refused at load.
assert.equal(DEFAULTS.ctaReason, "A NEW MATCH EVERY DAY");
assert.ok(DEFAULTS.ctaReason.length <= CTA_REASON_MAX_CHARS);
assert.doesNotThrow(() => validateOverrides({ ctaReason: "" }), "empty is the bare card");
assert.doesNotThrow(() => validateOverrides({ ctaReason: "W".repeat(CTA_REASON_MAX_CHARS) }));
assert.throws(() => validateOverrides({ ctaReason: "W".repeat(CTA_REASON_MAX_CHARS + 1) }), /ctaReason/);
assert.throws(() => validateOverrides({ ctaReason: "ONE ROW\nNOT TWO" }), /ctaReason/);
assert.throws(
  () => validateOverrides({ ctaReason: "NOWY MECZ CO DZIEŃ" }),
  /ctaReason/,
  "non-ASCII falls back to another font",
);
assert.throws(() => validateOverrides({ ctaReason: null }), /ctaReason/);
assert.throws(() => validateOverrides({ ctaReason: 5 }), /ctaReason/);

console.log("config: all checks passed");
