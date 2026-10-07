// Integration self-check for studioBrowser.ts + studioActions.ts: a real Chrome, headed, on a
// real Xvfb display, connected over CDP exactly as production does — no `chromium.launch()`.
// Skipped (prints why, exits 0) when Xvfb or a Chromium binary is not on this machine: this is
// the one test in the repo that drives a browser the way the Studio automation actually will,
// which `npm test` runs alongside the other two that drive Chromium/ffmpeg (package.json).
// Run: npx tsx src/youtube/studioActions.test.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function xvfbAvailable(): boolean {
  try {
    execSync("command -v Xvfb", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function chromiumPath(): string | null {
  try {
    const exe = chromium.executablePath();
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const chromePath = chromiumPath();
if (!xvfbAvailable() || !chromePath) {
  console.log(
    `studioActions: skipped — ${!xvfbAvailable() ? "Xvfb" : "no Chromium binary (run `npx playwright install chromium`)"} not available here`,
  );
  process.exit(0);
}

// A fixture that mimics just enough of a watch page's comment thread for pinComment() to drive:
// one thread whose author link names the test channel, an "Action menu" button that opens a
// menu with a "Pin" item, which opens a confirm dialog with its own "Pin" button. Clicking that
// sets `window.__pinned`. `pinned` is the Node-side test's own record of whether a real pin has
// gone through yet — a real `page.goto()` reload serves fresh HTML each time, same as a real
// watch page would, so this is what makes the SECOND load show the pin as already there, rather
// than resetting to a thread nobody has pinned.
function fixtureHtml(pinned: boolean): string {
  const badge = pinned ? '<div id="pinned-badge">Pinned by Test Channel</div>' : "";
  return `<!doctype html><html><body>
  <style>button, tp-yt-paper-item, ytd-comment-thread-renderer { display: inline-block; padding: 4px; }</style>
  ${badge}
  <ytd-comment-thread-renderer>
    <a id="author-text" href="https://www.youtube.com/channel/TESTCHANNEL123">Test Channel</a>
    <button aria-label="Action menu">&#8942;</button>
  </ytd-comment-thread-renderer>
  <script>
    window.__pinned = ${pinned};
    document.addEventListener("click", (e) => {
      if (e.target.matches('button[aria-label="Action menu"]')) {
        const item = document.createElement("tp-yt-paper-item");
        item.id = "pin-menu-item";
        item.textContent = "Pin";
        document.body.appendChild(item);
      } else if (e.target.id === "pin-menu-item") {
        e.target.remove();
        const dialog = document.createElement("div");
        dialog.id = "confirm-dialog";
        dialog.innerHTML = '<button id="confirm-pin">Pin</button><button id="cancel-pin">Cancel</button>';
        document.body.appendChild(dialog);
      } else if (e.target.id === "confirm-pin") {
        window.__pinned = true;
        document.getElementById("confirm-dialog")?.remove();
        const badge = document.createElement("div");
        badge.textContent = "Pinned by Test Channel";
        document.body.appendChild(badge);
      }
    });
  </script>
</body></html>`;
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-studio-fixture-"));
const profileDir = mkdtempSync(path.join(tmpdir(), "mcsr-studio-profile-"));
const { config } = await import("../config.js");
const mediaDir = config.mediaDir;
config.mediaDir = media;

const { page: pageOf, start } = await import("./studioBrowser.js");
const { pinComment } = await import("./studioActions.js");

const matchId = 1;
mkdirSync(path.join(media, String(matchId)), { recursive: true });

// --no-sandbox: this agent's own container has no usable Chromium sandbox (no unprivileged user
// namespaces — the same message Chrome gives on some locked-down Ubuntu kernels), so plain
// `start()` never gets past spawn here. Test-only: production's own default carries no such flag
// (studioBrowser.ts), and the real Studio login never runs where this matters.
const handle = await start({
  profileDir,
  chromePath,
  debugPort: 9293,
  display: ":97",
  extraArgs: ["--no-sandbox"],
});
try {
  const page = await pageOf(handle);
  let pinnedOnServer = false;
  await page.route("https://www.youtube.com/watch**", (route) =>
    route.fulfill({ body: fixtureHtml(pinnedOnServer), contentType: "text/html" }),
  );

  // Dry run: clicks through to opening the confirm dialog, screenshots it, and stops — the pin
  // itself must never actually happen.
  const dry = await pinComment(handle, "vidTest", {
    matchId,
    dryRun: true,
    channelId: "TESTCHANNEL123",
  });
  assert.equal(dry, "pinned", `dry run: ${JSON.stringify(dry)}`);
  assert.equal(await page.evaluate(() => (window as unknown as { __pinned?: boolean }).__pinned), false);
  console.log("OK: dryRun opens the confirm dialog and stops before clicking it");

  // The real thing: a fresh navigation (the route re-serves the fixture, resetting its state)
  // clicks all the way through to the confirm button.
  const real = await pinComment(handle, "vidTest", { matchId, channelId: "TESTCHANNEL123" });
  assert.equal(real, "pinned", `real run: ${JSON.stringify(real)}`);
  assert.equal(await page.evaluate(() => (window as unknown as { __pinned?: boolean }).__pinned), true);
  assert.equal(await page.locator("text=/Pinned by/i").first().isVisible(), true);
  console.log("OK: a real run clicks through menu, item and confirm, and pins it");

  // Calling it a second time on an already-pinned thread must never unpin or replace it — the
  // next load now serves the pin as already there, same as a real watch page reload would.
  pinnedOnServer = true;
  const again = await pinComment(handle, "vidTest", { matchId, channelId: "TESTCHANNEL123" });
  assert.equal(again, "already-pinned");
  console.log("OK: an already-pinned thread is left alone, not re-pinned");

  const shots = readdirSync(path.join(media, String(matchId))).filter((f) => f.startsWith("studio-"));
  assert.ok(shots.length >= 2, `expected before/after screenshots on disk, got: ${shots.join(", ")}`);
  console.log(`OK: screenshots landed in the match directory (${shots.length})`);
} finally {
  await handle.stop();
  config.mediaDir = mediaDir;
  rmSync(media, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
console.log("studioActions: all checks passed");
