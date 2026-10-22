// src/x/xBrowserState.ts + the browser poster's gates and config keys, no browser.
// Run: npx tsx src/x/xBrowserState.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS, validateOverrides } from "../config.js";
import { SETTINGS } from "../dashboard/settings.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-xstate-"));
process.on("exit", () => rmSync(media, { recursive: true, force: true }));
config.mediaDir = media;
process.env.X_PROFILE_DIR = path.join(media, "never-created-x-profile");
const { readXBrowserState, updateXBrowserState, xBrowserNeedsYou, xBrowserStatePath } = await import("./xBrowserState.js");
const { xTooSoon } = await import("./xPost.js");
const { xBrowserTick } = await import("./xBrowser.js");

// --- the flag: default off, config-file only, in the example ------------------------------------
assert.equal(DEFAULTS.xBrowserPost, false);
validateOverrides({ xBrowserPost: true });
assert.throws(() => validateOverrides({ xBrowserPost: "yes" }), /xBrowserPost/);
assert.ok(!SETTINGS.some((f) => f.key === "xBrowserPost"), "never writable from the Settings tab");
const example = JSON.parse(readFileSync(new URL("../../mcsr-vid.config.example.json", import.meta.url), "utf8"));
assert.equal(example.xBrowserPost, false, "npm run config:example was run");
console.log("OK: xBrowserPost defaults off, validates as a boolean, is not a Settings field, is in the example");

assert.equal(DEFAULTS.xHandle, "mcsrreplayoffs");
assert.equal(DEFAULTS.xMinHoursBetweenPosts, 40);
validateOverrides({ xHandle: "Some_Handle1", xMinHoursBetweenPosts: 0 });
for (const bad of ["@mcsrreplayoffs", "", "a handle", "x".repeat(16), 7])
  assert.throws(() => validateOverrides({ xHandle: bad }), /xHandle/, JSON.stringify(bad));
for (const bad of [-1, 721, "40", null])
  assert.throws(() => validateOverrides({ xMinHoursBetweenPosts: bad }), /xMinHoursBetweenPosts/, JSON.stringify(bad));
for (const key of ["xHandle", "xMinHoursBetweenPosts"]) {
  assert.ok(!SETTINGS.some((f) => f.key === key), `${key} is never writable from the Settings tab`);
  assert.equal(example[key], DEFAULTS[key as keyof typeof DEFAULTS], `${key} is in the example`);
}
console.log("OK: xHandle and xMinHoursBetweenPosts: defaults, validation, config-file only, in the example");

// --- the state file ----------------------------------------------------------------------------
assert.equal(readXBrowserState(), null, "no file yet");
assert.deepEqual(xBrowserNeedsYou(null, true), []);
updateXBrowserState({ lastProbe: "ok", lastProbeAt: "2026-10-22T10:00:00.000Z" });
assert.deepEqual(readXBrowserState(), {
  lastProbe: "ok",
  lastProbeAt: "2026-10-22T10:00:00.000Z",
  lastPostAt: null,
  lastError: null,
  lastErrorAt: null,
  lastMatchId: null,
  unconfirmed: null,
  lastDryRunAt: null,
});
updateXBrowserState({ lastError: "X did not finish processing the video in time\nstack", lastMatchId: 7 });
assert.equal(readXBrowserState()?.lastProbe, "ok", "a patch keeps the other fields");
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X post failed: X did not finish processing the video in time",
]);
updateXBrowserState({ lastProbe: "signed-out", lastError: null });
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), ["X: signed out, sign in with npm run x -- login"]);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), false), [], "flag off: silent");
updateXBrowserState({ lastProbe: "verify", lastError: "boom" });
assert.equal(xBrowserNeedsYou(readXBrowserState(), true).length, 2, "a verify prompt and an error are both lines");
updateXBrowserState({ lastProbe: "wrong-account", lastError: null });
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X: the browser is not signed in as @mcsrreplayoffs, sign in with npm run x -- login",
]);
updateXBrowserState({ lastProbe: "ok", unconfirmed: { matchId: 9, at: "2026-10-22T10:00:00.000Z", error: "no toast" } });
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X: post may have gone out unconfirmed, check x.com/mcsrreplayoffs (match 9)",
]);
writeFileSync(xBrowserStatePath(), "not json");
assert.equal(readXBrowserState(), null, "garbage reads as nothing");
updateXBrowserState({ lastProbe: "ok" });
assert.equal(readXBrowserState()?.lastError, null, "garbage is replaced, not merged");
console.log("OK: .x-browser.json merges patches atomically; Needs-you lines only when the flag is on");

// --- one a UTC day and xMinHoursBetweenPosts apart, shared with the API poster -------------------
const now = Date.parse("2026-10-22T12:00:00.000Z");
const match = (id: number, at: string, postId = "browser:1") => {
  mkdirSync(path.join(media, String(id)), { recursive: true });
  writeFileSync(path.join(media, String(id), "x.json"), JSON.stringify({ postId, at, text: "t", mediaId: "", via: "browser" }));
};
assert.equal(await xTooSoon(now), null);
match(100, "2026-10-20T19:00:00.000Z");
assert.equal(await xTooSoon(now), null, "41h ago: past the 40h gap");
match(101, "2026-10-21T08:00:00.000Z");
assert.equal(await xTooSoon(now), "last post 28h ago (match 101), under the 40h gap", "yesterday, but inside the gap");
config.xMinHoursBetweenPosts = 0;
assert.equal(await xTooSoon(now), null, "0: the daily rule alone");
config.xMinHoursBetweenPosts = 40;
match(102, "2026-10-22T00:01:00.000Z", "browser:pending");
assert.equal(await xTooSoon(now), "already posted today (match 102)", "an unconfirmed click counts as posted");
assert.equal(await xBrowserTick({ now }), "already posted today (match 102)", "no browser is started");
console.log("OK: the browser tick stops at the shared gate: one a UTC day, 40h apart, a pending click included");

// --- the tick's own gates, all before any browser -----------------------------------------------
config.xAutoPost = true;
Object.assign(process.env, { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "a" });
assert.equal(await xBrowserTick({ now }), "API poster is on; browser poster idle");
for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) delete process.env[k];
config.xAutoPost = false;

updateXBrowserState({ lastError: "X did not finish processing\nstack", lastErrorAt: "2026-10-22T09:00:00.000Z" });
assert.equal(await xBrowserTick({ now }), "failed today, next try tomorrow: X did not finish processing");
updateXBrowserState({ lastErrorAt: "2026-10-21T09:00:00.000Z" });
assert.equal(await xBrowserTick({ now }), "already posted today (match 102)", "yesterday's failure: tried again today");
assert.equal(readXBrowserState()?.lastError, null, "a tick that attempts nothing clears an earlier day's error");
updateXBrowserState({ lastError: null, lastDryRunAt: "2026-10-22T08:00:00.000Z" });
assert.equal(await xBrowserTick({ now, dryRun: true }), "dry run already done today");
assert.equal(await xBrowserTick({ now }), "already posted today (match 102)", "the dry-run gate is the dry run's only");

// An unconfirmed click's line stays while its x.json reads browser:pending, and goes once the
// operator has settled it (X's id written in, or the file deleted).
updateXBrowserState({ unconfirmed: { matchId: 102, at: "2026-10-22T00:01:00.000Z", error: "no toast" } });
await xBrowserTick({ now });
assert.equal(readXBrowserState()?.unconfirmed?.matchId, 102, "still pending: the line stays");
match(102, "2026-10-22T00:01:00.000Z", "1849000000000000001");
await xBrowserTick({ now });
assert.equal(readXBrowserState()?.unconfirmed, null, "settled: the line goes");
console.log("OK: the tick idles beside an armed API poster, after a failure today, after today's dry run; settles unconfirmed");
assert.ok(!existsSync(process.env.X_PROFILE_DIR), "no browser, no profile dir");
console.log("xBrowserState: all OK");
