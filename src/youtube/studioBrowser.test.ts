// Self-check for studioBrowser.ts's pure half: classify() needs no browser at all, and
// startAndProbe()'s stop-on-failure shape is tested with fake start/probe deps instead of a
// real Chrome.
// Run: npx tsx src/youtube/studioBrowser.test.ts
import assert from "node:assert/strict";
import { classify, startAndProbe, type StudioHandle } from "./studioBrowser.js";

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

console.log("studioBrowser: all checks passed");
