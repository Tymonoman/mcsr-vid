// Self-check for studioLogin.ts: the refusal logic, pure and without a browser.
// Run: npx tsx src/dashboard/studioLogin.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-studio-login-test-"));
const mediaDir = config.mediaDir;
config.mediaDir = media;

try {
  const {
    finishLogin,
    killOrphanedLoginScreen,
    loginRefusal,
    loginStatus,
    secretConfigured,
    studioSecretOk,
  } = await import("./studioLogin.js");

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
  const savedSecret = process.env.STUDIO_LOGIN_SECRET;
  delete process.env.STUDIO_LOGIN_SECRET;
  assert.deepEqual(loginStatus(), { screen: "stopped", lastProbe: null, secretRequired: false });
  const doneWithNoScreen = await finishLogin();
  assert.deepEqual(doneWithNoScreen, { error: "no login screen is running" });

  // Unset: every request is let through, same trust model as every other dashboard route.
  assert.equal(secretConfigured(), false);
  assert.equal(studioSecretOk(undefined), true);
  assert.equal(studioSecretOk("anything"), true);

  // Set: only the exact string passes, and a wrong or missing one is refused rather than ignored —
  // the login screen hands over an interactive, already-authenticated Google session.
  process.env.STUDIO_LOGIN_SECRET = "s3cret-token";
  assert.equal(secretConfigured(), true);
  assert.equal(studioSecretOk("s3cret-token"), true);
  assert.equal(studioSecretOk("wrong"), false);
  assert.equal(studioSecretOk(undefined), false);
  assert.equal(studioSecretOk(""), false);
  if (savedSecret === undefined) delete process.env.STUDIO_LOGIN_SECRET;
  else process.env.STUDIO_LOGIN_SECRET = savedSecret;

  // killOrphanedLoginScreen: no pidfile at all is a silent no-op.
  const profileDir = await mkdtemp(path.join(tmpdir(), "mcsr-studio-profile-test-"));
  killOrphanedLoginScreen(profileDir);

  // A pidfile naming a real, running process that is NOT actually x11vnc/websockify (a reused pid
  // in a fresh container, the one scenario the cmdline check exists for) must be left alone and
  // the stale pidfile still removed.
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100)); // let /proc/<pid>/cmdline exist
  const pidFile = path.join(profileDir, ".studio-login.json");
  await writeFile(
    pidFile,
    JSON.stringify({ x11vncPid: sleeper.pid, websockifyPid: sleeper.pid, expiresAt: Date.now() }),
  );
  killOrphanedLoginScreen(profileDir);
  assert.equal(existsSync(pidFile), false, "the pidfile is removed either way");
  let stillAlive = true;
  try {
    process.kill(sleeper.pid!, 0);
  } catch {
    stillAlive = false;
  }
  assert.equal(stillAlive, true, "a pid that is not actually x11vnc/websockify is never signalled");
  sleeper.kill("SIGKILL");
  await rm(profileDir, { recursive: true, force: true });

  console.log("studioLogin: all checks passed");
} finally {
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
