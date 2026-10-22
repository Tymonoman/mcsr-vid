/**
 * The config loader's half of the Settings tab (src/config.ts: DEFAULTS, validateOverrides, the
 * boot-time load), tested from the docs alone — CLAUDE.md "Settings tab", "What the render
 * produces", "Known pitfalls"; handbook/claude-md-reference.md l.96-129 and l.759-770; README.md.
 * src/config.test.ts already pins most per-key rules; this file covers what it does not.
 *
 * The promises, as the docs make them:
 *  C1  "test:unit runs on DEFAULTS so a Settings-tab switch can't break it": MCSR_CONFIG at a
 *      missing file loads exactly DEFAULTS.
 *  C2  The three switches the Settings tab may not write ship in their safe position — uploads off,
 *      the nightly chain "off", no Studio browser — and the lab turns them on by hand.
 *  C3  The loader holds those switches to their exact type: nightlyUpload is one of "off",
 *      "private", "scheduled" (a stray space is not "scheduled"); the other two are booleans.
 *  C4  ctaReason is "≤24 plain-ASCII chars": every printable ASCII character is accepted, anything
 *      else (tab, DEL, no-break space, accents, emoji, fullwidth) is refused.
 *  C5  introSec is seconds from 2 to 7: a non-finite number is refused.
 *  C6  teaserAtSec: null is "none"; a non-finite or non-number value is refused.
 *  C7  The defaults the docs state for the Settings-tab keys are the defaults the code ships.
 *  C8  The file is validated at boot: one holding Settings-tab values boots merged over DEFAULTS,
 *      and one holding a value outside the rules refuses to boot, naming the key — which is why the
 *      panel must never write such a file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mcsr-config-settings-contract-"));
// Removed however the run ends: a failing assert must not leave the scratch dir in /tmp.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
// Hermetic whatever the runner exported: a file that is not there, as test:unit sets it.
process.env.MCSR_CONFIG = path.join(dir, "missing", "mcsr-vid.config.json");
const { config, DEFAULTS, validateOverrides } = await import("./config.js");

// --- C1: no file is DEFAULTS, exactly -----------------------------------------------------------
assert.deepEqual(config, DEFAULTS, "a missing config file loads every key at its default");
console.log("config.settings.contract: a missing file loads DEFAULTS");

// --- C2, C3: the deliberate switches --------------------------------------------------------------
// A config default that changes what goes on the channel or what a nightly does is a house-rule break.
assert.equal(DEFAULTS.youtubeUploadEnabled, false);
assert.equal(DEFAULTS.nightlyUpload, "off");
assert.equal(DEFAULTS.studioAutomation, false);
assert.equal(DEFAULTS.communityPolls, false);
for (const ok of ["off", "private", "scheduled"])
  assert.doesNotThrow(() => validateOverrides({ nightlyUpload: ok }));
// A typo there would otherwise read as "off" at the one switch deciding whether a nightly uploads.
for (const bad of ["scheduled ", "Scheduled", "", true, null, 1]) {
  assert.throws(
    () => validateOverrides({ nightlyUpload: bad }),
    /nightlyUpload/,
    `nightlyUpload ${JSON.stringify(bad)}`,
  );
}
for (const key of ["youtubeUploadEnabled", "studioAutomation", "communityPolls"]) {
  assert.doesNotThrow(() => validateOverrides({ [key]: true }));
  for (const bad of ["true", 1, null]) {
    assert.throws(() => validateOverrides({ [key]: bad }), new RegExp(key), `${key} ${JSON.stringify(bad)}`);
  }
}
console.log("config.settings.contract: the deliberate switches ship off and take only their own type");

// --- C4: the subscribe card's reason, one plain-ASCII row --------------------------------------
{
  // All 95 printable ASCII characters, 24 at a time: none of them is a reason to refuse a row.
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
  for (let i = 0; i < printable.length; i += 24) {
    const row = printable.slice(i, i + 24);
    assert.doesNotThrow(() => validateOverrides({ ctaReason: row }), `ctaReason ${JSON.stringify(row)}`);
  }
  // Anything else falls back to another font than Monocraft and can overflow the row.
  for (const bad of [
    "NEW\tMATCH",
    "NEW MATCH\x7F",
    "NEW\u00A0MATCH",
    "CAFÉ RACE",
    "NEW MATCH \u{1F525}",
    "ＮＥＷ",
  ]) {
    assert.throws(
      () => validateOverrides({ ctaReason: bad }),
      /ctaReason/,
      `ctaReason ${JSON.stringify(bad)}`,
    );
  }
  console.log("config.settings.contract: ctaReason takes every printable ASCII character and nothing else");
}

// --- C5, C6: the intro card and the teaser take real seconds -------------------------------------
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  assert.throws(() => validateOverrides({ introSec: bad }), /introSec/, `introSec ${bad}`);
  assert.throws(() => validateOverrides({ teaserAtSec: bad }), /teaserAtSec/, `teaserAtSec ${bad}`);
}
assert.throws(() => validateOverrides({ teaserAtSec: true }), /teaserAtSec/, "a boolean is not seconds");
assert.doesNotThrow(() => validateOverrides({ teaserAtSec: null }), "null is the documented none");
assert.doesNotThrow(() => validateOverrides({ teaserAtSec: 0 }), "0 s is a time, at match start");
console.log("config.settings.contract: introSec and teaserAtSec refuse non-finite seconds");

// --- C7: the documented defaults ------------------------------------------------------------------
{
  // Each value as CLAUDE.md / the handbook / README state it (keys config.test.ts already pins are left out).
  const DOCUMENTED: Record<string, unknown> = {
    teaserAtSec: 10, // "from teaserAtSec (default 10, Settings → Publishing, empty = none)"
    teaserSec: 5, // "for teaserSec (5)"
    midRollCtaAtSec: 90, // "midRollCtaAtSec (Settings → Publishing, default 90, null=none)"
    midRollCtaSec: 4, // "shows SUBSCRIBE for midRollCtaSec (4)s"
    shortsByHand: false, // "shortsByHand (Settings → Publishing, default off)"
    countdownTeaser: false, // "countdownTeaser, default off"
    thumbnailRotatePoses: false, // "thumbnailRotatePoses (default off)"
    learnedDraw: false, // "learnedDraw/recordPaceBoostSec (Settings tab, both default off)"
    recordPaceBoostSec: null,
    creatorWatch: false, // "Creator watch (creatorWatch/creatorWatchlist, Settings tab, off/empty by default)"
    creatorWatchlist: [],
    playoffsFirst: true, // "playoffsFirst (default true)" since 18 Oct 2026
    playoffThumbnailStyle: "plain", // handbook: "Default "plain""
    exportUpscale1440: false, // "exportUpscale1440 (default off)"
    povAudioPan: 0.7, // "povAudioPan, default 0.7"
    postRollSec: 30, // "tail ≤ postRollSec = 30s"
    nightlyRenderHourUtc: 3, // "at nightlyRenderHourUtc (default 3 UTC, null disables)"
    publishHourUtc: 19, // "publishHourUtc 19:00 UTC ranked"
    seriesPublishHourUtc: 23, // "seriesPublishHourUtc 23:00 series"
    seriesPairGapDays: 3, // "seriesPairGapDays 3 apart"
    suggestKnownSlots: 4, // "suggestKnownSlots, default 4"
    rivalChannelHandle: ["mcsrmatches", "mcsr-vault"], // "rivalChannelHandle (a list) default mcsrmatches + mcsr-vault"
    nightlyMaxRenders: 1, // README: "up to nightlyMaxRenders matches (default 1; 2 at the lab)"
  };
  for (const [key, value] of Object.entries(DOCUMENTED)) {
    assert.deepEqual(DEFAULTS[key as keyof typeof DEFAULTS], value, `${key}'s default is the documented one`);
  }
  console.log("config.settings.contract: the documented defaults are the shipped ones");
}

// --- C8: the loader validates at boot -------------------------------------------------------------
{
  const file = path.join(dir, "mcsr-vid.config.json");
  let n = 0;
  const bootOn = async (overrides: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify(overrides), "utf8");
    process.env.MCSR_CONFIG = file;
    return ((await import(`./config.js?boot=${++n}`)) as { config: Record<string, unknown> }).config;
  };
  // The values the lab runs (README: "3 at the lab", 1440p on) boot merged over everything else.
  const lab = await bootOn({ introSec: 3, teaserAtSec: null, ctaReason: "", exportUpscale1440: true });
  assert.equal(lab.introSec, 3);
  assert.equal(lab.teaserAtSec, null, "an explicit none beats the default 10");
  assert.equal(lab.ctaReason, "", "an explicit bare card beats the default reason");
  assert.equal(lab.exportUpscale1440, true);
  assert.equal(lab.publishHourUtc, DEFAULTS.publishHourUtc, "untouched keys keep their default");
  // A file the panel must never write: the dashboard would not come back up on it.
  for (const [bad, key] of [
    [{ introSec: 8 }, "introSec"],
    [{ ctaReason: "A ROW THAT RUNS PAST TWENTY-FOUR" }, "ctaReason"],
    [{ teaserAtSec: "10" }, "teaserAtSec"],
    [{ nightlyUpload: "on" }, "nightlyUpload"],
  ] as const) {
    await assert.rejects(bootOn(bad), new RegExp(key), `a file with ${JSON.stringify(bad)} refuses to boot`);
  }
  console.log("config.settings.contract: the file is validated at boot, naming the key");
}

console.log("config.settings.contract: all checks passed");
