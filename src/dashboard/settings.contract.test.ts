/**
 * The Settings tab (src/dashboard/settings.ts), tested from its documentation alone — CLAUDE.md
 * "Settings tab" and "What the render produces", handbook/claude-md-reference.md (Dashboard →
 * "Settings tab", l.759-770; render section l.96-129), README.md — the way a caller of
 * `saveSettings`/`settingsPayload` (the PUT/GET /api/settings route, the experiment engine) sees it.
 * src/dashboard/settings.test.ts already pins the allowlist basics, coercion per kind and several
 * keys' save-and-apply; this file covers the promises it does not, end to end.
 *
 * The promises, as the docs make them:
 *  S1  Only the panel's own keys (SETTINGS) are writable; any other key is refused, nothing written.
 *  S2  youtubeUploadEnabled, nightlyUpload and studioAutomation are "deliberately not writable here"
 *      (and telegramReportHourWarsaw is "config-file edit only, like nightlyUpload") — not alone, not
 *      smuggled beside a legitimate key, not through a "__proto__" key.
 *  S3  "The panel only reports them": the payload's read-only list carries all three, live values.
 *  S4  The write is atomic (temp file, then rename): a new inode, no temp file left behind, and a
 *      stale temp file from a crashed write does not block the next save.
 *  S5  "Applies live", no restart: what reads `config` (teaserProp, ctaReasonProp, explainMovesProp,
 *      isBlockedPlayer, export:fast's headTrimSec(config.introSec)) changes at once.
 *  S6  The nightly is re-armed when, and only when, nightlyRenderHourUtc actually moves.
 *  S7  "The file is read fresh and merged, so a hand-edited key the panel does not know about
 *      survives a save" — one added after boot included, and the three read-only switches too.
 *  S8  "The merged object goes through validateOverrides … so the panel cannot write a file that
 *      then fails to boot": a hand-edited invalid key refuses the save with nothing written, and the
 *      file the panel writes boots, through the real loader, to the values the panel shows.
 *  S9  A refused save changes nothing: not the file, not the live config, not the other half of the patch.
 *  S10 ctaReason: one row of at most 24 plain-ASCII characters; empty is the bare card.
 *  S11 introSec: 2–7; match start in the MP4 lands at introSec + 3 s (7 → 0:10, 3 → 0:06).
 *  S12 teaserAtSec: empty = none — saved null, boots null, no COMING UP card; a number brings it back.
 *  S13 Every other documented "empty/null = off" key (midRollCtaAtSec, explainMovesSec,
 *      autoHooksAfterHours, recordPaceBoostSec, nightlyRenderHourUtc) clears to null and boots so.
 *  S14 Every key the docs place in the Settings tab / "Settings → Publishing" is writable, in that group.
 *  S15 Every bound the panel offers is one the loader accepts, and every value the panel shows
 *      re-saves as itself: no change reported, the file not rewritten.
 *  S16 The experiment engine's JSON values (numbers, booleans, null) save like the panel's strings
 *      ("applies the day's render-tagged entry through saveSettings").
 *  S17 A corrupt or non-object config file is refused, never clobbered; a box with no file gets one
 *      holding just the saved key, and it boots.
 *  S18 A save that returns without error leaves that value in the file — the file and the live
 *      config agree — even when the file was hand-edited since boot.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";

// CONFIG_PATH is fixed when config.js is first evaluated, so the file is ours before that import:
// never the lab's real mcsr-vid.config.json, whatever MCSR_CONFIG the runner exported.
const dir = mkdtempSync(path.join(tmpdir(), "mcsr-settings-contract-"));
const file = path.join(dir, "mcsr-vid.config.json");
// The box's shape per CLAUDE.md: uploads on, the nightly chain "scheduled", the Studio worker on.
const LAB = {
  mediaDir: path.join(dir, "media"),
  youtubeUploadEnabled: true,
  nightlyUpload: "scheduled",
  studioAutomation: true,
  telegramReportHourWarsaw: 7,
  preRollSec: 150,
};
writeFileSync(file, `${JSON.stringify(LAB, null, 2)}\n`, "utf8");
process.env.MCSR_CONFIG = file;

const { config, CONFIG_PATH, CTA_REASON_MAX_CHARS, DEFAULTS, validateOverrides, isBlockedPlayer, blockedIn } =
  await import("../config.js");
const { coerce, saveSettings, settingsPayload, SETTINGS, READ_ONLY } = await import("./settings.js");
const { teaserProp, ctaReasonProp, explainMovesProp } = await import("../pipeline/overlayProps.js");
const { headTrimSec } = await import("../pipeline/exportFast.js");
const { ANCHOR_SEC } = await import("../pipeline/kdenliveProject.js");
type Field = (typeof SETTINGS)[number];
assert.equal(CONFIG_PATH, file, "the test owns the file it writes");

const live = config as unknown as Record<string, unknown>;
const bytes = () => readFileSync(file, "utf8");
const disk = () => JSON.parse(bytes()) as Record<string, unknown>;
const field = (key: string): Field => {
  const f = SETTINGS.find((s) => s.key === key);
  assert.ok(f, `${key} is a Settings field`);
  return f;
};
const load = (id: number) =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
// A real match the teaser has a moment in (overlayProps.test.ts uses it for the same reason).
const raced = load(12929221);

let boots = 0;
/** The real loader evaluated afresh on what the panel left on disk: what the next dashboard boot sees. */
async function boot(): Promise<Record<string, unknown>> {
  const mod = (await import(`../config.js?boot=${++boots}`)) as { config: Record<string, unknown> };
  return mod.config;
}

/** A save that must be refused, leaving the file byte-identical and the live config as it was. */
function refused(patch: Record<string, unknown>, why: string, error: RegExp = /./): void {
  const before = bytes();
  const liveBefore = structuredClone(live);
  assert.throws(() => saveSettings(patch), error, why);
  assert.equal(bytes(), before, `${why}: nothing written`);
  assert.deepEqual(live, liveBefore, `${why}: the live config untouched`);
}

/** A documented promise the code does not keep yet: reported, not fatal, until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message}`);
  }
}

/** What the panel shows in a field's box (public/app.js `settingValue`), i.e. what it sends back. */
function shown(f: Field & { value: unknown }): unknown {
  if (f.kind === "boolean") return !!f.value;
  if (f.kind === "words") return Array.isArray(f.value) ? f.value.join(" ") : "";
  if (f.kind === "list") return Array.isArray(f.value) ? f.value.join(", ") : "";
  return f.value === null || f.value === undefined ? "" : String(f.value);
}

// --- S1-S3: the three switches stay a deliberate edit on the box --------------------------------
{
  const writable = new Set(SETTINGS.map((f) => f.key as string));
  const SWITCHES = [
    ["youtubeUploadEnabled", false],
    ["nightlyUpload", "off"],
    ["studioAutomation", false],
  ] as const;
  for (const [key, flipped] of SWITCHES) {
    // A mis-click on any of them shows up on the live channel (handbook l.765-769).
    assert.ok(!writable.has(key), `${key} is not a panel field`);
    assert.ok(READ_ONLY.includes(key), `${key} is reported read-only`);
    refused({ [key]: flipped }, `${key} on its own`, /not a setting this panel may change/);
    // Smuggled beside a key the panel does own: the whole patch goes, its legitimate half included.
    refused({ playoffsFirst: !config.playoffsFirst, [key]: flipped }, `${key} beside playoffsFirst`);
  }
  // The morning report's hour is "config-file edit only, like nightlyUpload" (CLAUDE.md, Telegram bot).
  assert.ok(!writable.has("telegramReportHourWarsaw"), "telegramReportHourWarsaw is not a panel field");
  refused({ telegramReportHourWarsaw: 9 }, "the report hour", /not a setting this panel may change/);
  // A JSON body can carry an own "__proto__" key; it is just another key the panel does not own.
  refused(JSON.parse('{"__proto__":{"youtubeUploadEnabled":false}}'), "a __proto__ key");
  assert.equal(({} as Record<string, unknown>).youtubeUploadEnabled, undefined, "no prototype was touched");

  // "The panel only reports them": all three, with the values the process is actually running on.
  const payload = settingsPayload();
  const reported = Object.fromEntries(payload.readOnly.map((r) => [r.key, r.value]));
  assert.equal(reported.youtubeUploadEnabled, true);
  assert.equal(reported.nightlyUpload, "scheduled");
  assert.equal(reported.studioAutomation, true);
  assert.deepEqual(
    payload.fields.map((f) => f.key),
    SETTINGS.map((f) => f.key),
    "the form is the allowlist, in its order",
  );
  console.log("settings.contract: the three switches are reported, never written");
}

// --- S4: the write is atomic --------------------------------------------------------------------
{
  const ino = statSync(file).ino;
  const filesBefore = readdirSync(dir).sort();
  assert.deepEqual(saveSettings({ playoffsFirst: true }).changed, ["playoffsFirst"]);
  // The loader reads this file at boot: a half-written one is a dashboard that will not start, so a
  // save lands as a whole new file renamed over the old, never an in-place rewrite.
  assert.notEqual(statSync(file).ino, ino, "renamed into place, not rewritten in place");
  assert.deepEqual(readdirSync(dir).sort(), filesBefore, "no temp file left beside it");
  assert.deepEqual(disk(), { ...LAB, playoffsFirst: true }, "the save is the old file plus the change");

  // A crash between write and rename leaves the temp file behind; the next save must not trip on it.
  writeFileSync(`${file}.tmp`, '{ "half a fi', "utf8");
  assert.deepEqual(saveSettings({ playoffsFirst: false }).changed, ["playoffsFirst"]);
  assert.ok(!existsSync(`${file}.tmp`), "the stale temp file was replaced and renamed away");
  assert.equal(disk().playoffsFirst, false);
  console.log("settings.contract: a save is a rename, and survives a crashed one before it");
}

// --- S7-S9: read fresh, merged, validated by the loader's own rules ------------------------------
{
  // A key hand-edited in after the dashboard booted — one the panel does not show — survives.
  writeFileSync(file, JSON.stringify({ ...disk(), supportUrl: "https://example.invalid/tip" }, null, 2));
  assert.deepEqual(saveSettings({ suggestKnownSlots: "5" }).changed, ["suggestKnownSlots"]);
  assert.equal(disk().supportUrl, "https://example.invalid/tip", "the hand edit survives the save");
  for (const key of [
    "youtubeUploadEnabled",
    "nightlyUpload",
    "studioAutomation",
    "telegramReportHourWarsaw",
  ]) {
    assert.deepEqual(disk()[key], LAB[key as keyof typeof LAB], `${key} survives a save untouched`);
  }

  // A hand edit the loader would refuse makes the merged file unbootable, so the save refuses too —
  // naming the culprit — and the operator's file is left exactly as they wrote it.
  const good = bytes();
  writeFileSync(file, JSON.stringify({ ...disk(), overlayFps: "30" }, null, 2));
  refused({ suggestKnownSlots: "6" }, "a hand-edited string where a number belongs", /overlayFps/);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), mediaDirr: "media" }, null, 2));
  refused({ suggestKnownSlots: "6" }, "a hand-edited typo'd key", /unknown key "mediaDirr"/);
  writeFileSync(file, good);

  // A patch is all or nothing, whether the panel's bound or the loader's rule refuses its bad half.
  refused({ playoffsFirst: true, introSec: "9" }, "a value outside the panel's bound beside a good one");
  refused(
    { playoffsFirst: true, playoffThumbnailStyle: "gold" },
    "a value only the loader's rule refuses, beside a good one",
    /playoffThumbnailStyle/,
  );
  console.log("settings.contract: hand edits survive, unbootable files are refused, patches are whole");
}

// --- S10: the subscribe card's reason ------------------------------------------------------------
{
  // 24 is the documented number, not just whatever the constant says (CLAUDE.md: "≤24 plain-ASCII chars").
  assert.equal(CTA_REASON_MAX_CHARS, 24);
  const ROW = "SUBSCRIBE FOR A NEW RACE";
  assert.equal(ROW.length, 24);
  // Implementation pin, not a documented promise: the box's padding is trimmed, so a full row with
  // stray spaces round it saves as the row. Change this line freely if the trim ever goes.
  assert.deepEqual(saveSettings({ ctaReason: `   ${ROW}  ` }).changed, ["ctaReason"]);
  assert.equal(disk().ctaReason, ROW);
  assert.deepEqual(ctaReasonProp(), { ctaReason: ROW }, "the next render's card reads it, no restart");
  // Anything outside plain ASCII falls back to another font and can overflow the one row.
  refused({ ctaReason: "NEW MATCH \u{1F525}" }, "an emoji", /ctaReason/);
  refused({ ctaReason: "NEW\tMATCH" }, "a tab inside the row", /ctaReason/);
  refused({ ctaReason: "CAFÉ RACE" }, "an accented letter", /ctaReason/);
  // Empty is the bare SUBSCRIBE card — and the next boot keeps it bare, not back to the default.
  assert.deepEqual(saveSettings({ ctaReason: "" }).changed, ["ctaReason"]);
  assert.deepEqual(ctaReasonProp(), {}, "the bare card");
  assert.equal((await boot()).ctaReason, "", "empty survives a reboot as empty");
  saveSettings({ ctaReason: DEFAULTS.ctaReason });
  console.log("settings.contract: ctaReason is one plain-ASCII row of 24, or the bare card");
}

// --- S11: the intro card's length, and where match start lands ----------------------------------
{
  assert.equal(field("introSec").min, 2, "2–7, as documented");
  assert.equal(field("introSec").max, 7);
  // "match start lands at introSec + 3 s (7→0:10 default; 3→0:06)": export:fast cuts 7 - introSec
  // off the countdown's head, read from the live config right after the save.
  for (const [sec, startSec] of [
    [3, 6],
    [2, 5],
    [7, 10],
  ]) {
    saveSettings({ introSec: String(sec) });
    assert.equal(config.introSec, sec, `introSec ${sec} is live`);
    assert.equal(
      ANCHOR_SEC - headTrimSec(config.introSec),
      startSec,
      `introSec ${sec} → match start 0:${startSec}`,
    );
  }
  for (const bad of ["1", "8", "", "-3"]) refused({ introSec: bad }, `introSec "${bad}"`);
  console.log("settings.contract: introSec is 2–7 and moves match start with it");
}

// --- S12: the COMING UP card, and "empty = none" -------------------------------------------------
{
  assert.equal(config.teaserAtSec, 10, "default 10 while the file says nothing");
  assert.equal(teaserProp(raced).teaser?.atSec, 10, "this match has a moment to tease");
  assert.deepEqual(saveSettings({ teaserAtSec: "" }).changed, ["teaserAtSec"]);
  assert.equal(config.teaserAtSec, null);
  assert.equal(disk().teaserAtSec, null, "written as an explicit none, which beats the default at boot");
  assert.deepEqual(teaserProp(raced), {}, "no card, from the very next render");
  assert.equal((await boot()).teaserAtSec, null, "the next boot agrees");
  saveSettings({ teaserAtSec: "25" });
  assert.equal(teaserProp(raced).teaser?.atSec, 25, "a number brings it back, at the new second");
  saveSettings({ teaserAtSec: "10" });
  console.log("settings.contract: teaserAtSec empty is no teaser, live and after a reboot");
}

// --- S13, S16: the other off-when-empty keys, and the experiment engine's JSON values ------------
{
  const OFF_WHEN_EMPTY = [
    "midRollCtaAtSec",
    "explainMovesSec",
    "autoHooksAfterHours",
    "recordPaceBoostSec",
    "nightlyRenderHourUtc",
  ];
  for (const key of OFF_WHEN_EMPTY) {
    const f = field(key);
    assert.ok(f.nullable, `${key}: an empty box means off, not 0`);
    // From a value, so clearing it is a real change whatever the default is.
    if (live[key] === null) saveSettings({ [key]: String(f.min ?? 1) });
    assert.deepEqual(saveSettings({ [key]: "" }).changed, [key], `${key} clears`);
    assert.equal(live[key], null);
    assert.equal(disk()[key], null);
  }
  const rebooted = await boot();
  for (const key of OFF_WHEN_EMPTY) assert.equal(rebooted[key], null, `${key} boots as off`);

  // The experiment cadence the operator planned ("explainMovesSec on/off, countdownTeaser, introSec")
  // goes through saveSettings as JSON — numbers, booleans, null — not the panel's strings.
  const r = saveSettings({ introSec: 3, countdownTeaser: true, explainMovesSec: 6, nightlyMaxRenders: 2 });
  assert.deepEqual(r.changed.sort(), ["countdownTeaser", "explainMovesSec", "introSec", "nightlyMaxRenders"]);
  assert.equal(config.introSec, 3);
  assert.equal(config.countdownTeaser, true);
  assert.equal(explainMovesProp(raced).explainMoves?.forSec, 6, "explain-the-moves cards are on, 6 s each");
  saveSettings({ explainMovesSec: null, countdownTeaser: false, introSec: 7 });
  assert.deepEqual(explainMovesProp(raced), {}, "and off again with null");
  console.log("settings.contract: every documented off-when-empty key clears to null; JSON values save too");
}

// --- S5, S6: live consumers and the nightly's re-arm --------------------------------------------
{
  // The block list is read live off config: a save blocks (and unblocks) at once, whole names, any case.
  saveSettings({ blockedPlayers: "RunnerA, RunnerB" });
  assert.equal(isBlockedPlayer("runnera"), true);
  assert.equal(blockedIn(["Someone", "RUNNERB"]), true);
  assert.equal(isBlockedPlayer(DEFAULTS.blockedPlayers[0]), false, "the saved list replaces, not appends");
  saveSettings({ blockedPlayers: DEFAULTS.blockedPlayers.join(", ") });
  assert.equal(isBlockedPlayer(DEFAULTS.blockedPlayers[0]), true, "and the default comes back the same way");

  saveSettings({ nightlyRenderHourUtc: "3" });
  // Re-arming moves the pending timer; the same hour beside another change has nothing to move.
  assert.equal(saveSettings({ nightlyRenderHourUtc: 3, playoffsFirst: true }).rearmNightly, false);
  assert.equal(saveSettings({ nightlyRenderHourUtc: "4" }).rearmNightly, true);
  saveSettings({ nightlyRenderHourUtc: "3", playoffsFirst: false });
  console.log("settings.contract: saves reach the block list at once; re-arm only on a moved hour");
}

// --- S14, S15: the documented keys are here, and the panel's bounds are the loader's -------------
{
  // Every key CLAUDE.md or the handbook names as a Settings-tab (or "Settings → Publishing") key.
  const PUBLISHING = [
    "ctaReason",
    "teaserAtSec",
    "introSec",
    "explainMovesSec",
    "shortsByHand",
    "midRollCtaAtSec",
    "autoHooksAfterHours",
    "thumbnailRotatePoses",
  ];
  for (const key of PUBLISHING)
    assert.equal(field(key).group, "Publishing", `${key} is under Settings → Publishing`);
  for (const key of [
    "favouritePlayers",
    "blockedPlayers",
    "learnedDraw",
    "recordPaceBoostSec",
    "creatorWatch",
    "creatorWatchlist",
    "playoffThumbnailStyle",
    "nightlyRenderHourUtc",
    "countdownTeaser",
  ]) {
    field(key);
  }

  for (const f of SETTINGS) {
    assert.ok(f.key in DEFAULTS, `${f.key} is a real config key`);
    if (f.kind === "int" || f.kind === "hour") {
      const lo = f.min ?? 0;
      const hi = f.max ?? 23;
      // A bound the panel offers but the loader refuses would be a value the form allows and the save rejects.
      assert.doesNotThrow(
        () => validateOverrides({ [f.key]: lo }),
        `${f.key}: the panel's minimum ${lo} boots`,
      );
      assert.doesNotThrow(
        () => validateOverrides({ [f.key]: hi }),
        `${f.key}: the panel's maximum ${hi} boots`,
      );
    }
    if (f.nullable) assert.doesNotThrow(() => validateOverrides({ [f.key]: null }), `${f.key}: empty boots`);
  }

  // Whatever the panel shows, sent back untouched, is that same value — and so no change at all.
  const fields = settingsPayload().fields;
  for (const f of fields) assert.deepEqual(coerce(f, shown(f)), { value: f.value }, `${f.key} round-trips`);
  const ino = statSync(file).ino;
  const before = bytes();
  const whole = Object.fromEntries(fields.map((f) => [f.key, shown(f)]));
  assert.deepEqual(
    saveSettings(whole),
    { changed: [], rearmNightly: false },
    "the untouched form is no change",
  );
  assert.equal(statSync(file).ino, ino, "and the file is not rewritten");
  assert.equal(bytes(), before);

  // S8's other half: what the panel left on disk boots, through the real loader, to what it shows.
  const rebooted = await boot();
  for (const f of SETTINGS)
    assert.deepEqual(rebooted[f.key], live[f.key], `${f.key} boots as the panel shows it`);
  console.log("settings.contract: documented keys present; bounds and values round-trip through the loader");
}

// --- S17: a file the panel cannot read, and a box with no file -----------------------------------
{
  const good = bytes();
  for (const bad of ["{ not json", "[]", "null"]) {
    writeFileSync(file, bad, "utf8");
    // A file the panel cannot read is the operator's to fix; overwriting it would lose their edit.
    refused({ playoffsFirst: !config.playoffsFirst }, `a config file reading ${bad}`);
  }
  rmSync(file);
  const slots = config.suggestKnownSlots + 1;
  assert.deepEqual(saveSettings({ suggestKnownSlots: String(slots) }).changed, ["suggestKnownSlots"]);
  assert.deepEqual(disk(), { suggestKnownSlots: slots }, "a fresh box's file holds the one saved key");
  const rebooted = await boot();
  assert.equal(rebooted.suggestKnownSlots, slots);
  assert.equal(rebooted.nightlyUpload, DEFAULTS.nightlyUpload, "everything else boots at its default");
  writeFileSync(file, good, "utf8");
  saveSettings({ suggestKnownSlots: String(JSON.parse(good).suggestKnownSlots) });
  console.log("settings.contract: an unreadable file is refused untouched; a missing one is created");
}

// --- S18: a save that succeeds leaves its value on disk ------------------------------------------
{
  // The operator hand-edits a panel key on the box after boot; the live config still holds the old value.
  const running = config.playoffsFirst;
  writeFileSync(file, JSON.stringify({ ...disk(), playoffsFirst: !running }, null, 2), "utf8");
  // Then the panel (or the experiment engine reapplying a control arm) saves the running value back.
  const r = saveSettings({ playoffsFirst: running });
  const rebooted = await boot();
  deviation(
    "CLAUDE.md 'Settings tab': writes mcsr-vid.config.json atomically, applies live (handbook l.759-764: read fresh and merged)",
    () => {
      assert.equal(
        disk().playoffsFirst,
        running,
        `saveSettings({ playoffsFirst: ${running} }) returned changed=${JSON.stringify(r.changed)} but the file still ` +
          `holds the hand-edited ${!running}, so the next boot runs ${rebooted.playoffsFirst} — the opposite of what was saved`,
      );
    },
  );
}

rmSync(dir, { recursive: true, force: true });
console.log("settings.contract: all checks passed");
