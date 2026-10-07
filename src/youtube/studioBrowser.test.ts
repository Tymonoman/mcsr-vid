// Self-check for studioBrowser.ts's pure half: classify() needs no browser at all.
// Run: npx tsx src/youtube/studioBrowser.test.ts
import assert from "node:assert/strict";
import { classify } from "./studioBrowser.js";

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

console.log("studioBrowser: all checks passed");
