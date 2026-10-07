// Self-check for studioLogin.ts: the refusal logic, pure and without a browser.
// Run: npx tsx src/dashboard/studioLogin.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-studio-login-test-"));
const mediaDir = config.mediaDir;
config.mediaDir = media;

try {
  const { finishLogin, loginRefusal, loginStatus } = await import("./studioLogin.js");

  // All clear.
  assert.equal(loginRefusal({ screenRunning: false, exportRunning: false, browserLocked: false }), null);

  // Each refusal, and the precedence when more than one is true — the screen already running is
  // the most specific ("this exact thing is already open") so it wins over the other two.
  assert.match(
    String(loginRefusal({ screenRunning: true, exportRunning: false, browserLocked: false })),
    /already running/,
  );
  assert.match(
    String(loginRefusal({ screenRunning: true, exportRunning: true, browserLocked: true })),
    /already running/,
    "the screen's own refusal wins over the other two",
  );
  assert.match(
    String(loginRefusal({ screenRunning: false, exportRunning: true, browserLocked: false })),
    /export is running/,
  );
  assert.match(
    String(loginRefusal({ screenRunning: false, exportRunning: true, browserLocked: true })),
    /export is running/,
    "an export in flight is checked before the browser lock — Chrome and ffmpeg share the cores",
  );
  assert.match(
    String(loginRefusal({ screenRunning: false, exportRunning: false, browserLocked: true })),
    /holds the browser/,
  );

  // Before anything has ever started: nothing is running, and `Done` has nothing to settle.
  assert.deepEqual(loginStatus(), { screen: "stopped", lastProbe: null });
  const doneWithNoScreen = await finishLogin();
  assert.deepEqual(doneWithNoScreen, { error: "no login screen is running" });

  console.log("studioLogin: all checks passed");
} finally {
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
