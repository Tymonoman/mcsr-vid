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
// test:unit points MCSR_CONFIG at a missing file for every other test; this one owns a real file.
delete process.env.MCSR_CONFIG;
writeFileSync(
  path.join(dir, "mcsr-vid.config.json"),
  JSON.stringify({ mediaDir: "/media", preRollSec: 150 }, null, 2),
  "utf8",
);

const { config, CONFIG_PATH, CTA_REASON_MAX_CHARS, isBlockedPlayer, reloadBlockedPlayers } =
  await import("../config.js");
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

// The subscribe card's reason is text, and empty is the bare card rather than null.
assert.deepEqual(coerce(field("ctaReason"), "  EVERY SINGLE DAY "), { value: "EVERY SINGLE DAY" });
assert.deepEqual(coerce(field("ctaReason"), ""), { value: "" });

// The favourite players are a comma-separated list, and empty is the empty list — "no bonus" — not
// null and not an error, so clearing the box is a way to switch the bonus off.
assert.deepEqual(coerce(field("favouritePlayers"), "doogile, Feinberg ,edcr"), {
  value: ["doogile", "Feinberg", "edcr"],
});
assert.deepEqual(coerce(field("favouritePlayers"), ""), { value: [] });
assert.deepEqual(coerce(field("favouritePlayers"), " , ,"), { value: [] }, "stray commas name nobody");
assert.ok(field("favouritePlayers").unattended, "it changes the nightly's pick, and the panel says so");

// The blocked players are the same list kind, empty likewise means none.
assert.deepEqual(coerce(field("blockedPlayers"), "Aquacorde, someoneElse"), {
  value: ["Aquacorde", "someoneElse"],
});
assert.deepEqual(coerce(field("blockedPlayers"), ""), { value: [] });
// A nickname is [A-Za-z0-9_]: a space or ";" separates too, never one name that blocks nobody.
assert.deepEqual(coerce(field("blockedPlayers"), "Aquacorde BeefSalad"), {
  value: ["Aquacorde", "BeefSalad"],
});
assert.deepEqual(coerce(field("blockedPlayers"), "Aquacorde; BeefSalad,\tFoo"), {
  value: ["Aquacorde", "BeefSalad", "Foo"],
});
assert.ok(
  field("blockedPlayers").unattended,
  "it changes what the nightly may render, and the panel says so",
);

// The pair-repeat window is whole days 0-30, and 0 is off, not an error and not an empty box.
assert.deepEqual(coerce(field("pairRepeatDays"), "0"), { value: 0 });
assert.deepEqual(coerce(field("pairRepeatDays"), "7"), { value: 7 });
assert.match(errorOf(coerce(field("pairRepeatDays"), "31")), /between 0 and 30/);
assert.match(errorOf(coerce(field("pairRepeatDays"), "")), /cannot be empty/);
assert.ok(field("pairRepeatDays").unattended, "it changes the nightly's pick too");

// Auto-hooks: off (empty) by default, whole hours 1-48 when it is on, and it says so.
assert.deepEqual(coerce(field("autoHooksAfterHours"), ""), { value: null });
assert.deepEqual(coerce(field("autoHooksAfterHours"), "6"), { value: 6 });
assert.match(errorOf(coerce(field("autoHooksAfterHours"), "49")), /between 1 and 48/);
assert.ok(field("autoHooksAfterHours").unattended, "it starts an upload nobody has looked at");

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

  // The subscribe card's reason: what fits one row saves and applies, a second row is refused by the
  // loader's own rule with nothing written, and emptying it is the bare card.
  assert.equal(saveSettings({ ctaReason: "EVERY SINGLE DAY" }).changed[0], "ctaReason");
  assert.equal(config.ctaReason, "EVERY SINGLE DAY");
  const row = readFileSync(CONFIG_PATH, "utf8");
  assert.throws(
    () => saveSettings({ ctaReason: "W".repeat(CTA_REASON_MAX_CHARS + 1) }),
    /ctaReason.*at most/,
  );
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), row, "a refused save writes nothing at all");
  assert.equal(config.ctaReason, "EVERY SINGLE DAY", "and the live value stays");
  assert.deepEqual(saveSettings({ ctaReason: "" }).changed, ["ctaReason"]);
  assert.equal(config.ctaReason, "", "empty is the bare SUBSCRIBE card, not null");
  console.log("settings: the subscribe card's reason saves, is held to one row, and can be emptied");

  // The favourite players: the roster until the panel says otherwise, then live at once — the
  // suggestion list and the nightly read `config` on every call, so nothing rescans or restarts.
  assert.ok(config.favouritePlayers.includes("doogile"), "the default roster is live before any save");
  assert.deepEqual(saveSettings({ favouritePlayers: "edcr, Feinberg" }).changed, ["favouritePlayers"]);
  assert.deepEqual(config.favouritePlayers, ["edcr", "Feinberg"]);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).favouritePlayers, ["edcr", "Feinberg"]);
  assert.deepEqual(saveSettings({ favouritePlayers: "edcr,Feinberg" }).changed, [], "same list, no change");
  assert.deepEqual(settingsPayload().fields.find((f) => f.key === "favouritePlayers")?.value, [
    "edcr",
    "Feinberg",
  ]);
  // Emptied, it is written as [] — an explicit "none" that beats the default roster on the next boot.
  assert.deepEqual(saveSettings({ favouritePlayers: "" }).changed, ["favouritePlayers"]);
  assert.deepEqual(config.favouritePlayers, []);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).favouritePlayers, []);

  console.log("settings: the favourite players save, apply live, and clear to none");

  // The blocked players: Aquacorde and BeefSalad by default, live at once, and clearable the same way.
  assert.deepEqual(config.blockedPlayers, ["Aquacorde", "BeefSalad"], "the default is live before any save");
  assert.deepEqual(saveSettings({ blockedPlayers: "Aquacorde, someoneElse" }).changed, ["blockedPlayers"]);
  assert.deepEqual(config.blockedPlayers, ["Aquacorde", "someoneElse"]);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).blockedPlayers, [
    "Aquacorde",
    "someoneElse",
  ]);
  assert.deepEqual(saveSettings({ blockedPlayers: "" }).changed, ["blockedPlayers"]);
  assert.deepEqual(config.blockedPlayers, [], "emptied is nobody blocked, not a missing key");
  // Left empty for the rest of this file's tests, which do not touch it; restored for anything
  // that runs after this process exits is the next boot's job, not this test's.
  assert.deepEqual(saveSettings({ blockedPlayers: "Aquacorde" }).changed, ["blockedPlayers"]);
  assert.deepEqual(config.blockedPlayers, ["Aquacorde"]);

  console.log("settings: the blocked players save, apply live, and clear to none");

  // Another process's view (the Studio worker's): a block the dashboard saved reaches it only by
  // re-reading the file, and only that key — nothing else on the box changes under it.
  const before = readFileSync(CONFIG_PATH, "utf8");
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...JSON.parse(before), blockedPlayers: ["Aquacorde", "doogile"], pairRepeatDays: 9 }),
  );
  assert.equal(isBlockedPlayer("doogile"), false, "this process has not read the file yet");
  reloadBlockedPlayers();
  assert.equal(isBlockedPlayer("doogile"), true, "the block saved elsewhere applies after a reload");
  assert.equal(config.pairRepeatDays, 3, "and nothing but the blocklist is reloaded");
  writeFileSync(CONFIG_PATH, "{");
  assert.throws(() => reloadBlockedPlayers(), "an unreadable file throws rather than runs on a stale list");
  assert.deepEqual(config.blockedPlayers, ["Aquacorde", "doogile"], "and leaves the live list alone");
  writeFileSync(CONFIG_PATH, before);
  reloadBlockedPlayers();
  assert.deepEqual(config.blockedPlayers, ["Aquacorde"]);

  console.log("settings: reloadBlockedPlayers picks up a block saved by another process, and only that");

  // The pair-repeat window: 3 until changed, live at once like the list, and a bad one writes nothing.
  assert.equal(config.pairRepeatDays, 3, "the default window is live before any save");
  assert.deepEqual(saveSettings({ pairRepeatDays: "5" }).changed, ["pairRepeatDays"]);
  assert.equal(config.pairRepeatDays, 5);
  assert.equal(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).pairRepeatDays, 5);
  const kept = readFileSync(CONFIG_PATH, "utf8");
  assert.throws(() => saveSettings({ pairRepeatDays: "31" }), /between 0 and 30/);
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), kept, "a refused save writes nothing at all");
  assert.deepEqual(saveSettings({ pairRepeatDays: "0" }).changed, ["pairRepeatDays"]);
  assert.equal(config.pairRepeatDays, 0, "0 is off, and it is a value, not a missing one");

  console.log("settings: the pair-repeat window saves, applies live, and turns off at 0");

  // The known-opponent follower threshold: 1,000 until changed, live at once, bounded like any int.
  assert.equal(config.knownFollowerThreshold, 10_000, "the default threshold is live before any save");
  assert.deepEqual(saveSettings({ knownFollowerThreshold: "5000" }).changed, ["knownFollowerThreshold"]);
  assert.equal(config.knownFollowerThreshold, 5000);
  assert.equal(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).knownFollowerThreshold, 5000);
  assert.throws(() => saveSettings({ knownFollowerThreshold: "-1" }), /between 0 and 1000000/);
  assert.deepEqual(saveSettings({ knownFollowerThreshold: "0" }).changed, ["knownFollowerThreshold"]);
  assert.equal(config.knownFollowerThreshold, 0, "0 is a value: every opponent off the list is known");

  console.log("settings: the known-opponent threshold saves, applies live, and is bounded");
}

process.chdir(cwd);
await rm(dir, { recursive: true, force: true });
