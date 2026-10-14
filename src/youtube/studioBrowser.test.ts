// Self-check for studioBrowser.ts's pure half: classify() needs no browser at all, and
// startAndProbe()'s stop-on-failure shape is tested with fake start/probe deps instead of a
// real Chrome. start()'s own cleanup runs against stub `Xvfb`/Chrome scripts, never the real ones.
// Run: npx tsx src/youtube/studioBrowser.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, isRunning, start, startAndProbe, type StudioHandle } from "./studioBrowser.js";

const CHANNEL = "UCm2mAyONTHlmIxZzNmi388w";

// Signed out: redirected to Google's own sign-in, whichever shape the redirect takes.
assert.equal(
  classify(
    "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://studio.youtube.com/",
    "Sign in - Google Accounts",
    "",
    CHANNEL,
  ),
  "signed-out",
);
assert.equal(
  classify("https://accounts.google.com/v3/signin/identifier", "Sign in", "", CHANNEL),
  "signed-out",
);

// A challenge or CAPTCHA page, by URL or by its own text, however Studio ends up showing it.
assert.equal(
  classify("https://accounts.google.com/signin/v2/challenge/az", "Confirm it's you", "", CHANNEL),
  "verify",
);
assert.equal(
  classify(
    "https://studio.youtube.com/",
    "Studio",
    "We need to verify it's you before you continue.",
    CHANNEL,
  ),
  "verify",
);
assert.equal(
  classify("https://studio.youtube.com/", "Studio", "Our systems detected unusual traffic", CHANNEL),
  "verify",
);

// Our own channel: ok.
assert.equal(
  classify(`https://studio.youtube.com/channel/${CHANNEL}/videos/upload`, "Channel content", "", CHANNEL),
  "ok",
);

// A different channel id in the URL: wrong-channel, even if our id also happens to appear in the
// page's own text somewhere (a stray mention must not override what the URL says it is).
assert.equal(
  classify(
    "https://studio.youtube.com/channel/UCsomeoneelse1234567890/videos/upload",
    "Channel content",
    `mentions ${CHANNEL} in passing`,
    CHANNEL,
  ),
  "wrong-channel",
);

// No channel id anywhere in the URL at all, and the page text never names ours either: cannot be
// confirmed as "ok", so it reads as the channel we cannot verify — never a false "ok".
assert.equal(classify("https://studio.youtube.com/", "Studio", "loading…", CHANNEL), "wrong-channel");

// No channel id in the URL, but the page text does carry ours — the fallback `probe()` leans on
// when Studio's own redirect is slow to land.
assert.equal(classify("https://studio.youtube.com/", "Studio", `channel ${CHANNEL}`, CHANNEL), "ok");

// Precedence: a signed-out URL wins even over a page that would otherwise read as ours — a login
// screen that happens to echo back the channel id in a query string must never read as "ok".
assert.equal(
  classify(
    `https://accounts.google.com/ServiceLogin?continue=https://studio.youtube.com/channel/${CHANNEL}`,
    "Sign in",
    "",
    CHANNEL,
  ),
  "signed-out",
);

// --- startAndProbe: stop-on-failure, including the regression (a throw from probe()) ---------
function fakeHandle(stopped: { count: number }): StudioHandle {
  return {
    browser: null as unknown as StudioHandle["browser"],
    debugPort: 0,
    async stop() {
      stopped.count++;
    },
  };
}

{
  // A non-"ok" probe result: stops and returns null, same as before this fix.
  const stopped = { count: 0 };
  const handle = fakeHandle(stopped);
  const result = await startAndProbe(
    {},
    {
      start: async () => handle,
      probe: async () => ({ result: "signed-out", url: "u", title: "t" }),
    },
  );
  assert.equal(result, null);
  assert.equal(stopped.count, 1, "a non-ok probe must stop the handle exactly once");
  console.log("OK: a non-ok probe stops Chrome and returns null");
}

{
  // The regression this fixes: probe() itself throwing (a goto timeout, a crashed renderer) must
  // still stop what start() spawned, not leak it.
  const stopped = { count: 0 };
  const handle = fakeHandle(stopped);
  await assert.rejects(
    startAndProbe(
      {},
      {
        start: async () => handle,
        probe: async () => {
          throw new Error("loading Studio: no answer after 30000ms");
        },
      },
    ),
    /no answer after 30000ms/,
  );
  assert.equal(stopped.count, 1, "a throw from probe() must still stop the handle it leaked before this fix");
  console.log("OK: a throw from probe() stops Chrome instead of leaking it (the 8 Oct 2026 regression)");
}

{
  // An "ok" probe: the handle is returned, untouched, for the caller's own try/finally to stop.
  const stopped = { count: 0 };
  const handle = fakeHandle(stopped);
  const result = await startAndProbe(
    {},
    { start: async () => handle, probe: async () => ({ result: "ok", url: "u", title: "t" }) },
  );
  assert.equal(result, handle);
  assert.equal(stopped.count, 0, "an ok probe must not stop the handle — the caller owns it now");
  console.log("OK: an ok probe returns the handle without stopping it");
}

// --- start(): a connect that fails after the debug port answered ----------------------------
{
  // The stub Chrome answers /json/version like the real one (and takes the profile's
  // SingletonLock), then drops the websocket, so Playwright's connectOverCDP rejects after
  // waitForCdp has already passed. The stub Xvfb only records its pid.
  const bin = mkdtempSync(path.join(tmpdir(), "mcsr-studio-stubs-"));
  const profileDir = mkdtempSync(path.join(tmpdir(), "mcsr-studio-profile-"));
  writeFileSync(path.join(bin, "Xvfb"), `#!/bin/sh\necho $$ > ${bin}/xvfb.pid\nexec sleep 60\n`);
  const chromePath = path.join(bin, "chrome");
  writeFileSync(
    chromePath,
    `#!/usr/bin/env node
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const arg = (k) => process.argv.find((a) => a.startsWith("--" + k + "=")).split("=")[1];
const port = Number(arg("remote-debugging-port"));
const lock = path.join(arg("user-data-dir"), "SingletonLock");
fs.rmSync(lock, { force: true });
fs.symlinkSync(os.hostname() + "-" + process.pid, lock);
const server = http.createServer((req, res) =>
  res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/stub" })),
);
server.on("upgrade", (req, socket) => socket.destroy());
server.listen(port, "127.0.0.1");
`,
  );
  chmodSync(path.join(bin, "Xvfb"), 0o755);
  chmodSync(chromePath, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const debugPort = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  const opts = { profileDir, chromePath, debugPort, display: ":0" };
  const err = await start(opts).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, "start() must throw when connectOverCDP does");
  const chromePid = Number(/-(\d+)$/.exec(readlinkSync(path.join(profileDir, "SingletonLock")))![1]);
  const xvfbPid = Number(readFileSync(path.join(bin, "xvfb.pid"), "utf8"));
  assert.ok(await gone(chromePid), "a failed connect must kill the Chrome it spawned");
  assert.ok(await gone(xvfbPid), "a failed connect must stop the Xvfb it spawned");
  assert.equal(isRunning(), false);
  // The leak this fixes wedged every later start() on the live SingletonLock.
  await assert.rejects(start(opts), (e: Error) => !/already running/.test(e.message));
  console.log("OK: a connectOverCDP failure kills Chrome and Xvfb, and the next start() is not refused");
}

console.log("studioBrowser: all checks passed");
