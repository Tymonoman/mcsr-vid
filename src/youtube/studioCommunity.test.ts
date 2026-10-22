// Browser self-check for postCommunityPoll (src/youtube/studioCommunity.ts): a real Chrome on a
// real Xvfb display over CDP, exactly as studioActions.test.ts does, against a local fixture of
// the channel's Community tab — never youtube.com itself. Skipped (exit 0) without Xvfb or a
// Chromium binary. Listed with the browser tests in package.json's `test`, not `test:unit`.
// Run: npx tsx src/youtube/studioCommunity.test.ts
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
    `studioCommunity: skipped — ${!xvfbAvailable() ? "Xvfb" : "no Chromium binary (run `npx playwright install chromium`)"} not available here`,
  );
  process.exit(0);
}

// The Community tab as the composer's selectors guess it (UNCONFIRMED live — see
// studioCommunity.ts's own top comment): the owner's collapsed composer, a post-type row with an
// "Image poll" decoy before "Poll", two option inputs once Poll is chosen, a Post button that
// appends a `ytd-backstage-post-renderer` carrying the text and a youtu.be link. `posts` is the
// Node-side server's own list, so a reload (a fresh `goto`) shows what was posted before.
const state = {
  composer: true,
  posts: [] as Array<{ text: string; link: string }>,
};
function fixtureHtml(): string {
  const posts = state.posts
    .map(
      (p) =>
        `<ytd-backstage-post-renderer><div id="content-text">${p.text.replace(/\n/g, "<br>")}</div>` +
        `<a href="${p.link}">${p.link}</a></ytd-backstage-post-renderer>`,
    )
    .join("");
  const composer = state.composer
    ? `<ytd-backstage-post-dialog-renderer>
    <div id="placeholder" onclick="openComposer()">Post something to your channel</div>
    <div id="editor" style="display:none">
      <div id="contenteditable-root" contenteditable="true" style="white-space:pre-wrap;border:1px solid #888;min-height:40px"></div>
      <div id="types">
        <button type="button">Image</button>
        <button type="button" onclick="choosePoll()">Image poll</button>
        <button type="button" onclick="choosePoll()">Poll</button>
      </div>
      <div id="poll" style="display:none">
        <input type="text" placeholder="Option 1"><input type="text" placeholder="Option 2">
      </div>
      <div id="submit-button"><button type="button" onclick="post()">Post</button></div>
    </div>
  </ytd-backstage-post-dialog-renderer>`
    : "";
  return `<!doctype html><html><body>
  <style>button,input,div,ytd-backstage-post-dialog-renderer{display:block;margin:2px} ytd-backstage-post-renderer{display:block;border:1px solid #ccc;margin:4px}</style>
  ${composer}
  <div id="posts">${posts}</div>
  <script>
    function openComposer(){ document.getElementById("editor").style.display="block"; }
    function choosePoll(){ document.getElementById("poll").style.display="block"; }
    function post(){
      const text = document.getElementById("contenteditable-root").innerText.replace(/\\n+$/, "");
      const options = [...document.querySelectorAll("#poll input")].map(i => i.value);
      window.__posted = { text, options };
      const link = (text.match(/https:\\S+/) || [""])[0];
      const el = document.createElement("ytd-backstage-post-renderer");
      el.innerHTML = '<div id="content-text">' + text.replace(/\\n/g, "<br>") + '</div><a href="' + link + '">' + link + "</a>";
      document.getElementById("posts").prepend(el);
    }
  </script>
</body></html>`;
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-community-fixture-"));
const profileDir = mkdtempSync(path.join(tmpdir(), "mcsr-community-profile-"));
const { config } = await import("../config.js");
const mediaDir = config.mediaDir;
config.mediaDir = media;
const { isRunning, page: pageOf, start } = await import("./studioBrowser.js");
const { pollContentFor, postCommunityPoll } = await import("./studioCommunity.js");

const matchId = 1;
mkdirSync(path.join(media, String(matchId)), { recursive: true });
const channelId = "TESTCHANNEL123";
const poll = pollContentFor("HOOK | Skycrab vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun", "vidPoll1")!;

// --no-sandbox: see studioActions.test.ts (no usable Chromium sandbox in this container).
// Its own port/display, so the two browser tests never collide if ever run side by side.
const handle = await start({
  profileDir,
  chromePath,
  debugPort: 9317,
  display: ":93",
  extraArgs: ["--no-sandbox"],
});
try {
  const page = await pageOf(handle);
  await page.route(`https://www.youtube.com/channel/${channelId}/community**`, (route) =>
    route.fulfill({ body: fixtureHtml(), contentType: "text/html" }),
  );
  const posted = () => page.evaluate(() => (window as unknown as { __posted?: unknown }).__posted ?? null);

  // Dry run: opens the composer, picks Poll, fills everything, and stops before the Post click.
  const dry = await postCommunityPoll(handle, poll, { matchId, dryRun: true, channelId });
  assert.equal(dry, "posted", JSON.stringify(dry));
  assert.equal(await posted(), null, "nothing posted on a dry run");
  assert.equal(await page.locator("#poll input").nth(0).inputValue(), "Skycrab");
  assert.equal(await page.locator("#poll input").nth(1).inputValue(), "doogile");
  console.log("OK: dryRun fills the question, the two options and the link, and stops before Post");

  // Live: the Post click appends the post, and "posted" is only returned once it shows.
  const live = await postCommunityPoll(handle, poll, { matchId, channelId });
  assert.equal(live, "posted", JSON.stringify(live));
  assert.deepEqual(await posted(), {
    text: "WHO TAKES IT?\nSkycrab vs doogile is up: https://youtu.be/vidPoll1",
    options: ["Skycrab", "doogile"],
  });
  console.log("OK: a live run posts the poll and confirms it on the tab");

  // A tab that already carries this video's link: left alone, whoever posted it.
  state.posts = [
    {
      text: "WHO TAKES IT?\nSkycrab vs doogile is up: https://youtu.be/vidPoll1",
      link: "https://youtu.be/vidPoll1",
    },
  ];
  const again = await postCommunityPoll(handle, poll, { matchId, channelId });
  assert.equal(again, "already-posted");
  // Another video's post is not this one's.
  state.posts = [{ text: "other", link: "https://youtu.be/otherVid" }];
  const other = await postCommunityPoll(handle, poll, { matchId, dryRun: true, channelId });
  assert.equal(other, "posted");
  console.log("OK: an existing post with the link is already-posted; another video's is not");

  // No composer (not the owner here, or the markup moved): a clear error, no click anywhere.
  state.posts = [];
  state.composer = false;
  const missing = await postCommunityPoll(handle, poll, { matchId, channelId });
  assert.ok(
    typeof missing === "object" && /no community composer/.test(missing.error),
    JSON.stringify(missing),
  );
  console.log("OK: a missing composer is an error naming it");

  const shots = readdirSync(path.join(media, String(matchId))).filter((f) =>
    f.startsWith("studio-community-"),
  );
  assert.ok(
    shots.some((f) => f.includes("-opened-")) &&
      shots.some((f) => f.includes("-filled-")) &&
      shots.some((f) => f.includes("-after-")),
    `expected opened/filled/after screenshots, got: ${shots.join(", ")}`,
  );
  console.log(`OK: screenshots landed in the match directory (${shots.length})`);
} finally {
  await handle.stop();
  assert.equal(isRunning(), false, "the lock must clear once the browser actually stops");
  config.mediaDir = mediaDir;
  rmSync(media, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
console.log("studioCommunity: all checks passed");
