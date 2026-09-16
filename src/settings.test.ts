import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `CONFIG_PATH` is `path.resolve("mcsr-vid.config.json")`, evaluated when config.js is first
// imported — so this test owns a config file of its own by moving cwd BEFORE that import, rather
// than writing the lab's real one and trusting a `finally` to put it back. A SIGKILL mid-test
// would have left the production dashboard with whatever this file was asserting about.
const dir = mkdtempSync(path.join(tmpdir(), "mcsr-settings-"));
const cwd = process.cwd();
process.chdir(dir);
writeFileSync(
  path.join(dir, "mcsr-vid.config.json"),
  JSON.stringify({ mediaDir: "/media", preRollSec: 150 }, null, 2),
  "utf8",
);

const { config, CONFIG_PATH } = await import("./config.js");
const { coerce, saveSettings, SETTINGS, settingsPayload, READ_ONLY } = await import("./settings.js");
assert.equal(CONFIG_PATH, path.join(dir, "mcsr-vid.config.json"), "the test owns the file it writes");

// The upload switches are not something a mis-click may reach: they change what goes on the channel
// is locked private for good, so those two stay a deliberate edit on the box.
const writable = new Set(SETTINGS.map((f) => f.key as string));
assert.ok(!writable.has("youtubeUploadEnabled"), "youtubeUploadEnabled is not writable here");
assert.ok(!writable.has("nightlyUpload"), "nor is nightlyUpload");
assert.ok(READ_ONLY.includes("youtubeUploadEnabled"), "but the panel still reports where it stands");

// Nor is anything outside the allowlist, however well spelled.
assert.throws(() => saveSettings({ mediaDir: "/tmp/elsewhere" }), /not a setting this panel may change/);
assert.throws(() => saveSettings({ preRollSec: 5 }), /not a setting this panel may change/);
assert.throws(() => saveSettings({ nonsense: 1 }), /not a setting this panel may change/);

// --- Coercion: the panel sends strings, Config wants numbers, nulls and arrays ------------------
const field = (key: string) => SETTINGS.find((f) => f.key === key)!;
const errorOf = (r: unknown) => String((r as { error: string }).error);

assert.deepEqual(coerce(field("playoffsFirst"), true), { value: true });
assert.match(errorOf(coerce(field("playoffsFirst"), "true")), /true or false/);

// An empty hour is "no nightly at all", not midnight — the difference between off and 00:00 UTC.
assert.deepEqual(coerce(field("nightlyRenderHourUtc"), ""), { value: null });
assert.deepEqual(coerce(field("nightlyRenderHourUtc"), "3"), { value: 3 });
assert.match(errorOf(coerce(field("nightlyRenderHourUtc"), "24")), /between 0 and 23/);
assert.match(errorOf(coerce(field("nightlyRenderHourUtc"), "3.5")), /whole number/);

// A field that is not nullable must not quietly become 0 when the box is cleared.
assert.match(errorOf(coerce(field("publishHourUtc"), "")), /cannot be empty/);
assert.deepEqual(coerce(field("nightlyMaxRenders"), "4"), { value: 4 });
assert.match(errorOf(coerce(field("nightlyMaxRenders"), "9")), /between 1 and 4/);

// The reasoner command is words, and empty means "not configured" rather than an empty argv.
assert.deepEqual(coerce(field("reasonerCommand"), "agy -p {prompt} --output-format json"), {
  value: ["agy", "-p", "{prompt}", "--output-format", "json"],
});
assert.deepEqual(coerce(field("reasonerCommand"), "   "), { value: null });

console.log("settings: the allowlist holds and every kind coerces");

// --- Writing: the file the loader reads ---------------------------------------------------------
{
  const saved = saveSettings({ playoffsFirst: true, suggestCloseSlots: "9" });
  assert.deepEqual(saved.changed.sort(), ["playoffsFirst", "suggestCloseSlots"]);
  assert.equal(saved.rearmNightly, false, "nothing touched the nightly's hour");

  const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.playoffsFirst, true);
  assert.equal(onDisk.suggestCloseSlots, 9, "the string became a number");
  // The file is shared with whoever edits it on the box, so a key the panel does not know about
  // and one it deliberately does not expose both have to survive a save.
  assert.equal(onDisk.mediaDir, "/media");
  assert.equal(onDisk.preRollSec, 150);

  // Applied live, or the panel would report a value the process is not using.
  assert.equal(config.playoffsFirst, true);
  assert.equal(config.suggestCloseSlots, 9);
  assert.equal(settingsPayload().fields.find((f) => f.key === "playoffsFirst")?.value, true);

  // Saving the same values again is not a change, so the panel does not claim one.
  assert.deepEqual(saveSettings({ playoffsFirst: true }).changed, []);

  // Moving the nightly's hour is the one change that has to re-arm a pending timer.
  assert.equal(saveSettings({ nightlyRenderHourUtc: "5" }).rearmNightly, true);
  assert.equal(config.nightlyRenderHourUtc, 5);
  // ...and clearing it is "off", which the scheduler reads as arming nothing.
  assert.equal(saveSettings({ nightlyRenderHourUtc: "" }).rearmNightly, true);
  assert.equal(config.nightlyRenderHourUtc, null);

  // A value the loader would reject must never reach the file: the next boot would die on it.
  const good = readFileSync(CONFIG_PATH, "utf8");
  assert.throws(() => saveSettings({ nightlyMaxRenders: "0" }), /between 1 and 4/);
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), good, "a refused save writes nothing at all");

  console.log("settings: a save is atomic, validated, live, and leaves foreign keys alone");
}

process.chdir(cwd);
await rm(dir, { recursive: true, force: true });
