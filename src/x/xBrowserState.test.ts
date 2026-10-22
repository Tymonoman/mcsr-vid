// src/x/xBrowserState.ts + the browser poster's once-a-day gate and config flag, no browser.
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
const { postedToday } = await import("./xPost.js");
const { xBrowserTick } = await import("./xBrowser.js");

// --- the flag: default off, config-file only, in the example ------------------------------------
assert.equal(DEFAULTS.xBrowserPost, false);
validateOverrides({ xBrowserPost: true });
assert.throws(() => validateOverrides({ xBrowserPost: "yes" }), /xBrowserPost/);
assert.ok(!SETTINGS.some((f) => f.key === "xBrowserPost"), "never writable from the Settings tab");
const example = JSON.parse(readFileSync(new URL("../../mcsr-vid.config.example.json", import.meta.url), "utf8"));
assert.equal(example.xBrowserPost, false, "npm run config:example was run");
console.log("OK: xBrowserPost defaults off, validates as a boolean, is not a Settings field, is in the example");

// --- the state file ----------------------------------------------------------------------------
assert.equal(readXBrowserState(), null, "no file yet");
assert.deepEqual(xBrowserNeedsYou(null, true), []);
updateXBrowserState({ lastProbe: "ok", lastProbeAt: "2026-10-22T10:00:00.000Z" });
assert.deepEqual(readXBrowserState(), {
  lastProbe: "ok",
  lastProbeAt: "2026-10-22T10:00:00.000Z",
  lastPostAt: null,
  lastError: null,
  lastMatchId: null,
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
writeFileSync(xBrowserStatePath(), "not json");
assert.equal(readXBrowserState(), null, "garbage reads as nothing");
updateXBrowserState({ lastProbe: "ok" });
assert.equal(readXBrowserState()?.lastError, null, "garbage is replaced, not merged");
console.log("OK: .x-browser.json merges patches atomically; Needs-you lines only when the flag is on");

// --- once a UTC day, shared with the API poster ------------------------------------------------
const now = Date.parse("2026-10-22T12:00:00.000Z");
const match = (id: number, at: string) => {
  mkdirSync(path.join(media, String(id)), { recursive: true });
  writeFileSync(path.join(media, String(id), "x.json"), JSON.stringify({ postId: "browser:1", at, text: "t", mediaId: "", via: "browser" }));
};
assert.equal(await postedToday(now), null);
match(101, "2026-10-21T23:59:00.000Z");
assert.equal(await postedToday(now), null, "yesterday's post does not count");
match(102, "2026-10-22T00:01:00.000Z");
assert.equal((await postedToday(now))?.matchId, 102);
assert.equal(await xBrowserTick({ now }), "already posted today (match 102)", "no browser is started");
console.log("OK: the browser tick stops at the API poster's own once-a-UTC-day rule");
assert.ok(!existsSync(process.env.X_PROFILE_DIR), "no browser, no profile dir");
console.log("xBrowserState: all OK");
