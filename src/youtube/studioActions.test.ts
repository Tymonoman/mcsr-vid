// Integration self-check for studioBrowser.ts + studioActions.ts: a real Chrome, headed, on a
// real Xvfb display, connected over CDP exactly as production does — no `chromium.launch()`.
// Skipped (prints why, exits 0) when Xvfb or a Chromium binary is not on this machine: this is
// the one test in the repo that drives a browser the way the Studio automation actually will,
// which `npm test` runs alongside the other two that drive Chromium/ffmpeg (package.json).
// Run: npx tsx src/youtube/studioActions.test.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// A fixture that mimics just enough of a watch page's comment thread for pinComment() to drive,
// in the markup read off the live page 14 Oct 2026 (d_fi9zEqcFc): one thread whose author link
// (`authorHref`) names the test channel and whose ⋮ "Action menu" opens a `ytd-menu-popup-renderer`
// in `ytd-popup-container` (Pin / Edit / Delete); its Pin opens a `yt-confirm-dialog-renderer`
// whose `#confirm-button` sets `window.__pinned` and fills the thread's own "Pinned by" badge.
// Ahead of all of it sits the player's hidden "Show cards" button, text "InfoShopping" — the
// page-wide "Pin" match the old locator clicked (and timed out on). `confirmLands: false` is a
// confirm click that pins nothing. `pinned` is the Node-side test's own record of whether a real
// pin has gone through yet — a real `page.goto()` reload serves fresh HTML each time, same as a
// real watch page would, so this is what makes the SECOND load show the pin as already there,
// rather than resetting to a thread nobody has pinned.
function fixtureHtml(pinned: boolean, authorHref: string, confirmLands = true): string {
  const badge = pinned ? "Pinned by @TestHandle" : "";
  return `<!doctype html><html><body>
  <style>button, tp-yt-paper-item { display: inline-block; padding: 4px; } .ytp-cards-button { display: none; }</style>
  <button class="ytp-button ytp-cards-button" aria-label="Show cards"><span>Info</span><span>Shopping</span></button>
  <ytd-comment-thread-renderer>
    <div id="comment-container"><ytd-comment-view-model id="comment">
      <div id="pinned-comment-badge">${badge}</div>
      <a id="author-text" href="${authorHref}">@TestHandle</a>
      <div id="action-menu"><ytd-menu-renderer><yt-icon-button id="button">
        <button id="button" aria-label="Action menu">&#8942;</button>
      </yt-icon-button></ytd-menu-renderer></div>
    </ytd-comment-view-model></div>
  </ytd-comment-thread-renderer>
  <ytd-popup-container></ytd-popup-container>
  <script>
    window.__pinned = ${pinned};
    const popup = document.querySelector("ytd-popup-container");
    const item = (text) =>
      '<ytd-menu-navigation-item-renderer role="menuitem"><a><tp-yt-paper-item role="menuitem">' +
      '<yt-formatted-string>' + text + '</yt-formatted-string></tp-yt-paper-item></a></ytd-menu-navigation-item-renderer>';
    const button = (id, text) =>
      '<yt-button-renderer id="' + id + '"><yt-button-shape><button aria-label="' + text + '">' + text +
      '</button></yt-button-shape></yt-button-renderer>';
    document.addEventListener("click", (e) => {
      if (e.target.closest('button[aria-label="Action menu"]')) {
        popup.innerHTML = '<tp-yt-iron-dropdown><ytd-menu-popup-renderer role="menu"><tp-yt-paper-listbox id="items">' +
          item("Pin") + item("Edit") + item("Delete") + "</tp-yt-paper-listbox></ytd-menu-popup-renderer></tp-yt-iron-dropdown>";
      } else if (e.target.closest("ytd-menu-popup-renderer tp-yt-paper-item")?.textContent.trim() === "Pin") {
        popup.innerHTML = '<tp-yt-paper-dialog><yt-confirm-dialog-renderer><div id="main">' +
          "<h2>Pin this comment?</h2><div>If you already pinned a comment, this will replace it</div>" +
          "<div>" + button("cancel-button", "Cancel") + button("confirm-button", "Pin") + "</div>" +
          "</div></yt-confirm-dialog-renderer></tp-yt-paper-dialog>";
      } else if (e.target.closest("#confirm-button button")) {
        popup.innerHTML = "";
        if (${confirmLands}) {
          window.__pinned = true;
          document.getElementById("pinned-comment-badge").textContent = "Pinned by @TestHandle";
        }
      }
    });
  </script>
</body></html>`;
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-studio-fixture-"));
const profileDir = mkdtempSync(path.join(tmpdir(), "mcsr-studio-profile-"));
const profileDir2 = mkdtempSync(path.join(tmpdir(), "mcsr-studio-profile2-"));
const { config } = await import("../config.js");
const mediaDir = config.mediaDir;
const channelHandle = config.youtubeChannelHandle;
config.mediaDir = media;

const { isRunning, page: pageOf, start } = await import("./studioBrowser.js");
const {
  pinComment,
  addEndScreenFromTemplate,
  addRivalryEndScreen,
  startTestAndCompare,
  readTestAndCompare,
  checkRelatedVideoPicker,
  linkRelatedVideo,
} = await import("./studioActions.js");

const matchId = 1;
mkdirSync(path.join(media, String(matchId)), { recursive: true });

// --no-sandbox: this agent's own container has no usable Chromium sandbox (no unprivileged user
// namespaces — the same message Chrome gives on some locked-down Ubuntu kernels), so plain
// `start()` never gets past spawn here. Test-only: production's own default carries no such flag
// (studioBrowser.ts), and the real Studio login never runs where this matters.
const startOpts = {
  profileDir,
  chromePath,
  debugPort: 9293,
  display: ":97",
  extraArgs: ["--no-sandbox"],
};

// `start()` claims its in-process lock on its very first line, before Xvfb or Chrome ever spawn —
// a second call issued in the same tick (a different profile dir, so this is testing the
// in-process lock, not the profile's own SingletonLock) must be refused immediately rather than
// race the first one into spawning a second Xvfb/Chrome pair.
const first = start(startOpts);
const second = start({ ...startOpts, profileDir: profileDir2, debugPort: 9294 });
await assert.rejects(second, /already running in this process/);
console.log("OK: a concurrent start() is refused synchronously, before it can spawn anything");

const handle = await first;
try {
  const page = await pageOf(handle);
  let pinnedOnServer = false;
  // A real watch page links the author as `/@handle`; the dry run below still serves the
  // `/channel/<id>` shape, so both ways of naming our channel stay pinned.
  let authorHref = "/@TestHandle";
  let confirmLands = true;
  await page.route("https://www.youtube.com/watch**", (route) =>
    route.fulfill({ body: fixtureHtml(pinnedOnServer, authorHref, confirmLands), contentType: "text/html" }),
  );

  // A handle that is only a prefix of the author's is not ours: the comment is left alone. (The
  // 14 Oct 2026 bug: no caller passed a handle, so every real `/@` author read this way.)
  config.youtubeChannelHandle = "Test";
  const notOurs = await pinComment(handle, "vidTest", { matchId, channelId: "TESTCHANNEL123" });
  assert.equal(notOurs, "no-channel-comment", `prefix handle: ${JSON.stringify(notOurs)}`);
  console.log("OK: an author whose handle only starts with ours is not our comment");
  config.youtubeChannelHandle = "testhandle";

  authorHref = "https://www.youtube.com/channel/TESTCHANNEL123";

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

  // A confirm click that pins nothing is an error, never "pinned" — the worker marks "pinned" done.
  confirmLands = false;
  const silent = await pinComment(handle, "vidTest", { matchId, channelId: "TESTCHANNEL123" });
  assert.ok(typeof silent === "object" && /no "Pinned by" badge/.test(silent.error), JSON.stringify(silent));
  console.log("OK: a confirm that never shows the badge is an error, not a pin");
  confirmLands = true;

  // The real thing: a fresh navigation (the route re-serves the fixture, resetting its state)
  // clicks all the way through to the confirm button — found by the `/@` handle from config alone,
  // case-insensitively, since the channel id never appears in that link.
  authorHref = "/@TestHandle";
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

  // --- End screens + Test & Compare (phase 2/3, 8 Oct 2026) -----------------------------------
  // A fixture for the Details page's two dialogs (End Screens, A/B Testing), mimicking the real
  // UI's own role/id selectors from the 7 Oct 2026 exploration (`uiState` plays the Node-side
  // server; `window.__*` is what a real click would have actually done, read back below).
  const uiState = {
    endScreenHasElements: false,
    pickerHasResults: true,
    // "finished": the 22 Oct 2026 report shape, whose "New test" button clears it for a fresh form.
    abTest: "none" as "none" | "running" | "done" | "finished",
    // A "New test" whose click lands nowhere (a wrapper that swallows it).
    newTestDead: false,
    // Related video (phase 2's own second half, 8 Oct 2026 — tmp/studio3/, read-only, no Save
    // ever pressed live): the Short's Details-page sidebar control, "None" until something is
    // linked.
    relatedVideoLinked: false,
    // linkRelatedVideo's own picker results (11 Oct 2026, job 8d7d95a1 — real shape, confirmed
    // live): "none" is "No matching results", "match" renders a decoy card plus one whose
    // thumbnail actually names `relatedTargetId` (DOM order: decoy first, so a test that only
    // ever clicked "the first row" would click the wrong video), "miss" renders two cards, neither
    // naming `relatedTargetId` — results came back, just not the one asked for.
    relatedResults: "none" as "none" | "match" | "miss",
    relatedTargetId: "",
    // Same-rivalry end screen (19 Oct 2026, addRivalryEndScreen): the custom "+ Element" toolbar
    // alongside the starter gallery — `rivalryToolbar` off mimics the toolbar not existing at all
    // (a markup change, or a channel without it), the fallback-to-starter test's own setup.
    rivalryToolbar: true,
    // Off models the toolbar's own top-level button existing (haveToolbar reads true) but opening
    // it revealing nothing — a partial markup drift, distinct from the toolbar being gone outright.
    rivalryVideoChooserAvailable: true,
    rivalrySubscribeAvailable: true,
    rivalryVideoResults: "none" as "none" | "match",
    rivalryTargetId: "",
    rivalryPlaylistResults: "none" as "none" | "match",
    // false: a Save (the page's or the end-screen editor's) is clicked but no "Changes saved"
    // ever shows (14 Oct 2026 for Test & Compare, 15 Oct for end screens and related links).
    saveConfirms: true,
  };
  function editPageHtml(): string {
    return `<!doctype html><html><body>
    <style>button,div,input,ytcp-ab-test-dialog,ytcp-video-pick-dialog,ytcp-text-dropdown-trigger{display:block;padding:2px;}</style>
    <button id="endscreen-editor-link" role="button">End screen</button>
    <button id="ab-test-button" aria-label="A/B Testing">A/B Testing</button>
    <!-- Confirmed live 8 Oct 2026 (tmp/studio3/): clicking this opens the exact same
         ytcp-video-pick-dialog the end-screen "Import from video" fallback below already does —
         this fixture reuses that same dialog markup/selectors rather than inventing new ones.
         The label-plus-value shape (two children, not one bare text node) is the real page's own
         (outerHTML dump, 8 Oct 2026): a first live run read the trigger's whole innerText
         ("Related video\nNone") against /^none$/i and misreported a never-linked Short
         "already-linked" — a fixture with only the bare value text, as this one used to have,
         could not have caught that. -->
    <ytcp-text-dropdown-trigger id="linked-video-editor-link" onclick="openRelatedPicker()">
      <div class="label-text">Related video</div>
      <span class="dropdown-trigger-text">
        ${uiState.relatedVideoLinked ? "Some Other Video" : "None"}
      </span>
    </ytcp-text-dropdown-trigger>
    <!-- Page-level Save placed BEFORE dialog-root, same DOM order as the real page
         (s7r-endscreen-open.json: the page's own #save sits before the editor's own #save-button) —
         a reversion to a plain text-based Save selector plus .first() would click this one, not
         the editor's, and this fixture would catch it (the regression fixed 8 Oct 2026). -->
    <button id="save" onclick="window.__tcSaved=true;${uiState.saveConfirms ? "document.getElementById('saved-msg').style.display='block'" : ""}">Save</button>
    <div id="saved-msg" style="display:none">Changes saved</div>
    <div id="dialog-root"></div>
    <script>
      window.__state = ${JSON.stringify(uiState)};
      window.__endscreenSaved = false;
      window.__tcStarted = null;
      window.__tcSaved = false;
      window.__starterPicked = false;
      window.__pickerOpened = false;
      window.__rivalryVideo = null;
      window.__rivalryRowClicked = null;
      window.__rivalryPlaylistClicked = null;
      window.__subscribeAdded = false;
      function closeDialog() { document.getElementById("dialog-root").innerHTML = ""; }
      function renderEndScreen() {
        // Live run, 8 Oct 2026: the real End Screens editor has no aria-label="Close" element
        // at all (DOM-inspected, not a guess) — "Discard changes" is the confirmed "panel is
        // open" signal addEndScreenFromTemplate now waits on, so this fixture leaves Close out.
        // id="save-button"/"discard-button" mirror the real page's own ytcp-button wrapper ids
        // (s7r-endscreen-open.json) — distinct from the page-level #save button below, which a
        // plain text match alone cannot tell apart (the regression this fixture now guards).
        const hasElements = window.__state.endScreenHasElements;
        // The real gallery's own text (lui-endscreen-text.txt, 8 Oct 2026) always offers a "1
        // video, 1 subscribe" card alongside "Import from video" whenever the editor is empty —
        // the same exact text endscreenEmptyGallery already reads as "empty" at all, so a real
        // empty editor always gives clickStarterLayout something to find; this fixture mirrors
        // that rather than a hypothetical gallery with no cards at all (see
        // addEndScreenFromTemplate's own doc comment on why the Import path is a fallback nothing
        // here can actually drive into).
        document.getElementById("dialog-root").innerHTML =
          '<div><span>End Screens</span>' +
          (hasElements
            ? '<div>existing elements</div>'
            : // Live run, 8 Oct 2026 (s7R5FUKU0KQ): the real card is a role=gridcell with its
              // own aria-label holding the click handler — its inner .title text node sits
              // underneath it and intercepts nothing, so a plain text click there times out
              // forever (the regression this fixture now guards; pointer-events: none on the
              // title is what reproduces the real "intercepts pointer events" failure here).
              '<div role="gridcell" aria-label="1 video, 1 subscribe" tabindex="0" style="cursor:pointer" onclick="window.__starterPicked=true">' +
              '<div class="title" style="pointer-events:none">1 video, 1 subscribe</div></div>' +
              '<button onclick="window.__pickerOpened=true;openPicker()">Import from video</button>' +
              // The same-rivalry layout's own custom "+ Element" toolbar (19 Oct 2026,
              // addRivalryEndScreen) — UNCONFIRMED shape, same honesty as the gridcell above's own
              // live-confirmed one; off models the toolbar not existing at all (a markup change),
              // which the fallback-to-starter test below turns off to exercise.
              (window.__state.rivalryToolbar
                ? '<button aria-label="Add video element" onclick="openVideoChooser()">Video</button>' +
                  '<button aria-label="Add playlist element" onclick="openPlaylistPicker()">Playlist</button>' +
                  (window.__state.rivalrySubscribeAvailable
                    ? '<button aria-label="Add subscribe element" onclick="window.__subscribeAdded=true">Subscribe</button>'
                    : '') +
                  '<div id="video-chooser"></div>'
                : '')) +
          '<button id="discard-button" onclick="closeDialog()">Discard changes</button>' +
          // Shows the same "Changes saved" toast the page-level Save does (#saved-msg above) —
          // saveEndScreenChange (studioActions.ts) waits on it the same way startTestAndCompare
          // already waits on it for its own page Save.
          '<button id="save-button" onclick="window.__endscreenSaved=true;if(window.__state.saveConfirms)document.getElementById(\\'saved-msg\\').style.display=\\'block\\';closeDialog()">Save</button></div>';
      }
      function openPicker() {
        document.getElementById("dialog-root").innerHTML +=
          '<ytcp-video-pick-dialog><input oninput="onPickerInput(this.value)" /><div id="picker-results"></div></ytcp-video-pick-dialog>';
      }
      // The rivalry video element's own chooser ("Specific video" vs "Best for viewer") — both
      // buttons stay in the DOM once opened (unlike the starter gallery's one-shot "Import from
      // video"), so a failed search can close its own picker and still find "Best for viewer"
      // underneath it, the same defensive order addRivalryEndScreen's own video step relies on.
      function openVideoChooser() {
        document.getElementById("video-chooser").innerHTML = window.__state.rivalryVideoChooserAvailable
          ? '<button onclick="openRivalryVideoPicker()">Specific video</button>' +
            '<button onclick="window.__rivalryVideo=\\'best-for-viewer\\'">Best for viewer for this device</button>'
          : "";
      }
      function openRivalryVideoPicker() {
        document.getElementById("dialog-root").innerHTML +=
          '<ytcp-video-pick-dialog><input oninput="onRivalryVideoInput(this.value)" />' +
          '<button aria-label="Close" onclick="document.querySelector(\\'ytcp-video-pick-dialog\\')?.remove()">Close</button>' +
          '<div id="rivalry-video-results"></div></ytcp-video-pick-dialog>';
      }
      // Same shape as relatedCard below (a decoy card ahead of the real one in DOM order) — kept
      // separate rather than shared, so the rivalry and related-video tests stay independent.
      function rivalryVideoCard(id) {
        return '<ytcp-entity-card role="option" onclick="window.__rivalryRowClicked=\\'' + id + '\\';window.__rivalryVideo=\\'specific\\';' +
          'document.querySelector(\\'ytcp-video-pick-dialog\\')?.remove();">' +
          '<div class="thumbnail" style="background-image:url(&quot;https://i9.ytimg.com/vi/' + id +
          '/mqdefault.jpg&quot;)"></div></ytcp-entity-card>';
      }
      function onRivalryVideoInput(value) {
        const results = document.getElementById("rivalry-video-results");
        if (!value) { results.innerHTML = ""; return; }
        if (window.__state.rivalryVideoResults === "none") {
          results.innerHTML = '<div>No matching results. Please try again.</div>';
          return;
        }
        results.innerHTML = rivalryVideoCard("decoyRivalXYZ12") + rivalryVideoCard(window.__state.rivalryTargetId);
      }
      // The playlist element's own picker — same generic dialog, a plain text-matched row (a
      // playlist has no thumbnail to key off the way a video card does).
      function openPlaylistPicker() {
        document.getElementById("dialog-root").innerHTML +=
          '<ytcp-video-pick-dialog><input oninput="onPlaylistInput(this.value)" />' +
          '<button aria-label="Close" onclick="document.querySelector(\\'ytcp-video-pick-dialog\\')?.remove()">Close</button>' +
          '<div id="playlist-results"></div></ytcp-video-pick-dialog>';
      }
      function onPlaylistInput(value) {
        const results = document.getElementById("playlist-results");
        if (!value) { results.innerHTML = ""; return; }
        if (window.__state.rivalryPlaylistResults === "none") {
          results.innerHTML = '<div>No matching results. Please try again.</div>';
          return;
        }
        results.innerHTML =
          '<div role="option" onclick="window.__rivalryPlaylistClicked=\\'' + value + '\\';' +
          'document.querySelector(\\'ytcp-video-pick-dialog\\')?.remove()">' + value + '</div>';
      }
      // The related-video control's own picker — same dialog tag/input/no-results text as
      // openPicker() above (confirmed live, tmp/studio3/), but replaces dialog-root outright
      // rather than appending into an End Screens panel that was never opened on this page.
      // Carries its own Close button (confirmed live: this dialog closes clean, no discard
      // prompt, unlike the End Screens editor).
      function openRelatedPicker() {
        document.getElementById("dialog-root").innerHTML =
          '<ytcp-video-pick-dialog><input oninput="onRelatedPickerInput(this.value)" />' +
          '<button aria-label="Close" onclick="document.getElementById(\\'dialog-root\\').innerHTML=\\'\\'">Close</button>' +
          '<div id="picker-results"></div></ytcp-video-pick-dialog>';
      }
      // A result card's real shape (confirmed live, job 8d7d95a1): no href/id anywhere on it —
      // only its thumbnail's background-image names the video, which is what
      // relatedVideoPickerRowFor filters on. Its own footer has no "Select" button at all, so a
      // click is the whole confirm step — here it also removes the dialog outright, mirroring the
      // real page's own auto-close (confirmed live: reopening a Short just linked shows no
      // leftover dialog).
      function relatedCard(id) {
        return '<ytcp-entity-card role="option" onclick="window.__relatedRowClicked=\\'' + id + '\\';' +
          'document.querySelector(\\'ytcp-video-pick-dialog\\')?.remove();">' +
          '<div class="thumbnail" style="background-image:url(&quot;https://i9.ytimg.com/vi/' + id +
          '/mqdefault.jpg&quot;)"></div></ytcp-entity-card>';
      }
      function onRelatedPickerInput(value) {
        const results = document.getElementById("picker-results");
        if (!value) { results.innerHTML = ""; return; }
        const mode = window.__state.relatedResults;
        if (mode === "none") { results.innerHTML = '<div>No matching results. Please try again.</div>'; return; }
        // A decoy row always comes first in DOM order — relatedVideoPickerRowFor must still find
        // the right one by its own thumbnail id, never just the first result.
        results.innerHTML = relatedCard("decoyAbc1234") +
          (mode === "match" ? relatedCard(window.__state.relatedTargetId) : relatedCard("wrongId5678"));
      }
      function onPickerInput(value) {
        const results = document.getElementById("picker-results");
        if (!value) { results.innerHTML = ""; return; }
        results.innerHTML = window.__state.pickerHasResults
          ? '<div role="option" onclick="document.querySelector(\\'ytcp-video-pick-dialog\\').remove()">POQrpE0-5d8</div>'
          : '<div>No matching results. Please try again.</div>';
      }
      // Live run, 8 Oct 2026 (LUI5E7yF0zE): the dialog's own element is
      // ytcp-creator-experiment-create-dialog (ytcp-ab-test-dialog does not exist at all — the
      // original fixture matched its own wrong guess, not reality); title fields are
      // contenteditable divs by aria-label ("Add title N"), not <input>, with slot 1 holding the
      // live title already; thumbnail fields are real <input type="file"> (slot 1 pre-filled from
      // the live thumbnail, no upload needed — confirmed by the UI, not exercised by this fixture).
      function renderAbTest() {
        const s = window.__state.abTest;
        const root = document.getElementById("dialog-root");
        if (s === "none") {
          root.innerHTML =
            '<ytcp-creator-experiment-create-dialog><span>A/B Testing</span><button aria-label="Close" onclick="closeDialog()">Close</button>' +
            '<button id="chip-0" onclick="selectChip(\\'title\\')">Title only</button>' +
            '<button id="chip-1" onclick="selectChip(\\'thumbnail\\')">Thumbnail only</button>' +
            '<div id="chip-body"></div>' +
            '<button id="set-test-button" onclick="window.__tcStarted={kind:window.__chipKind,title2:window.__title2};closeDialog()">Set test</button></ytcp-creator-experiment-create-dialog>';
        } else if (s === "running") {
          root.innerHTML = '<div><span>A/B Testing</span><button aria-label="Close" onclick="closeDialog()">Close</button><p>Your test is live. Check back later.</p></div>';
        } else if (s === "finished") {
          // Dialog text captured 22 Oct 2026 (tc-finished-dialog.txt): the report ends with
          // "Test finished. Ran from …" and the buttons "New test" / "Done".
          root.innerHTML = '<tp-yt-paper-dialog><span>A/B Test report</span><button aria-label="Close" onclick="closeDialog()">Close</button>' +
            '<p>39.8%</p><p>Watch time share</p><p>Set this option</p><p>19.6%</p><p>Watch time share</p><p>Set this option</p>' +
            '<p>Test finished. Ran from October 17, 2026 at 7:00 PM to October 18, 2026 at 6:56 AM.</p>' +
            '<button onclick="window.__newTestClicked=true;if(!window.__state.newTestDead){document.getElementById(\\'nt-confirm\\').style.display=\\'block\\'}">New test</button><button onclick="closeDialog()">Done</button>' +
            '<div id="nt-confirm" role="dialog" style="display:none"><p>Start a new experiment?</p><p>This deletes your current experiment.</p><button onclick="document.getElementById(\\'nt-confirm\\').style.display=\\'none\\'">Cancel</button><button onclick="window.__newTestConfirmed=true;window.__state.abTest=\\'none\\';renderAbTest()">Continue</button></div></tp-yt-paper-dialog>';
        } else {
          // The finished report's shape, as read live on _2EOkOOX0PQ (11 Oct 2026), for a thumbnail test.
          root.innerHTML = '<div><span>A/B Test report</span><button aria-label="Close" onclick="closeDialog()">Close</button>' +
            '<p>We have a winner!</p><p>41.5%</p><p>Watch time share</p><p>Now visible to all viewers</p><p>58.5%</p><p>Watch time share</p><p>Winner</p>' +
            '<p>Test finished. Ran from October 8, 2026 to October 11, 2026.</p></div>';
        }
      }
      function selectChip(kind) {
        window.__chipKind = kind;
        document.getElementById("chip-body").innerHTML = kind === "title"
          ? '<div contenteditable="true" aria-label="Add title 1">live title</div>' +
            '<div contenteditable="true" aria-label="Add title 2" oninput="window.__title2=this.textContent"></div>'
          : '<input type="file" /><input type="file" />';
      }
      document.getElementById("endscreen-editor-link").addEventListener("click", renderEndScreen);
      document.getElementById("ab-test-button").addEventListener("click", renderAbTest);
    </script>
    </body></html>`;
  }
  await page.route("https://studio.youtube.com/video/**", (route) =>
    route.fulfill({ body: editPageHtml(), contentType: "text/html" }),
  );

  const players = [{ nickname: "edcr" }, { nickname: "doogile" }];

  // addEndScreenFromTemplate: already has one -> left alone, never saved.
  uiState.endScreenHasElements = true;
  const already = await addEndScreenFromTemplate(handle, "vidE1", "POQrpE0-5d8", { matchId });
  assert.equal(already, "already-has-endscreen");
  console.log('OK: addEndScreenFromTemplate leaves a video with elements alone ("already-has-endscreen")');

  // Empty: the starter-layout gallery is the primary path now (phase 4, 8 Oct 2026) — dry run
  // picks the card but never saves; a real run does, and neither ever opens the Import picker.
  uiState.endScreenHasElements = false;
  const dryStarter = await addEndScreenFromTemplate(handle, "vidE2", "POQrpE0-5d8", {
    matchId,
    dryRun: true,
  });
  assert.equal(dryStarter, "imported");
  assert.equal(await page.evaluate("window.__starterPicked"), true, "the starter card was clicked");
  assert.equal(await page.evaluate("window.__endscreenSaved"), false, "a dry run must never actually save");
  assert.equal(
    await page.evaluate("window.__pickerOpened"),
    false,
    "the starter layout path never opens Import",
  );
  console.log(
    "OK: addEndScreenFromTemplate's dry run picks the closest starter layout and stops before Save",
  );

  const realImport = await addEndScreenFromTemplate(handle, "vidE4", "POQrpE0-5d8", { matchId });
  assert.equal(realImport, "imported");
  assert.equal(await page.evaluate("window.__starterPicked"), true);
  assert.equal(await page.evaluate("window.__endscreenSaved"), true);
  assert.equal(
    await page.evaluate("window.__pickerOpened"),
    false,
    "the starter layout path never opens Import",
  );
  // The regression this guards: the page-level #save (DOM-first, same order as the real page)
  // must be left untouched — an id-scoped click, not a `.first()` guess across two same-text
  // buttons.
  assert.equal(
    await page.evaluate("window.__tcSaved"),
    false,
    "must click the end-screen editor's own Save (#save-button), not the page-level #save",
  );
  console.log("OK: a real run clicks the editor's own Save, scoped by id, not the page-level Save");

  // An editor Save with no "Changes saved" is an error, never "imported": on "imported" the worker
  // marks the video done in its ledger and never opens the editor again.
  uiState.saveConfirms = false;
  const unsavedEnd = await addEndScreenFromTemplate(handle, "vidE5", "POQrpE0-5d8", { matchId });
  uiState.saveConfirms = true;
  assert.equal(await page.evaluate("window.__endscreenSaved"), true, "the editor's Save was pressed");
  assert.ok(
    typeof unsavedEnd === "object" && "error" in unsavedEnd,
    `expected an error, got ${JSON.stringify(unsavedEnd)}`,
  );
  assert.match(unsavedEnd.error, /never showed "Changes saved"/);
  console.log('OK: an end-screen Save with no "Changes saved" is an error, never "imported"');

  // --- Same-rivalry end screen (19 Oct 2026 retention proposal) ------------------------------
  // Never touches a video that already has one, same rail as the starter-layout path above.
  uiState.endScreenHasElements = true;
  const rivalryAlready = await addRivalryEndScreen(handle, "vidR1", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: null,
  });
  assert.equal(rivalryAlready, "already-has-endscreen");
  console.log('OK: addRivalryEndScreen leaves a video with elements alone too ("already-has-endscreen")');
  uiState.endScreenHasElements = false;

  // No custom toolbar at all (a markup change, or a channel without it) falls back to the
  // starter template rather than leave the editor open unsaved.
  uiState.rivalryToolbar = false;
  const fellBack = await addRivalryEndScreen(handle, "vidR2", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: "edcr vs doogile · MCSR Ranked",
  });
  assert.deepEqual(fellBack, {
    outcome: "imported",
    layout: "starter",
    video: "none",
    playlist: false,
    subscribe: false,
  });
  assert.equal(await page.evaluate("window.__starterPicked"), true, "fell back to the starter card");
  assert.equal(await page.evaluate("window.__endscreenSaved"), true, "the fallback still saves");
  console.log("OK: no custom toolbar falls back to the starter template, saved");
  uiState.rivalryToolbar = true;

  // The real thing: a specific rival video found by its thumbnail id (not the decoy ahead of it
  // in DOM order), the matchup playlist found by its exact title, and Subscribe — dry run picks
  // all three and stops before Save.
  uiState.rivalryVideoResults = "match";
  uiState.rivalryTargetId = "rivalVid123";
  uiState.rivalryPlaylistResults = "match";
  const dryRivalry = await addRivalryEndScreen(handle, "vidR3", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: "edcr vs doogile · MCSR Ranked",
    dryRun: true,
  });
  assert.deepEqual(dryRivalry, {
    outcome: "imported",
    layout: "rivalry",
    video: "specific",
    playlist: true,
    subscribe: true,
  });
  assert.equal(
    await page.evaluate("window.__rivalryRowClicked"),
    "rivalVid123",
    "picked the real row, not the decoy ahead of it",
  );
  assert.equal(await page.evaluate("window.__rivalryPlaylistClicked"), "edcr vs doogile · MCSR Ranked");
  assert.equal(await page.evaluate("window.__subscribeAdded"), true);
  assert.equal(await page.evaluate("window.__endscreenSaved"), false, "a dry run must never actually save");
  console.log("OK: addRivalryEndScreen's dry run places video+playlist+subscribe and stops before Save");

  const realRivalry = await addRivalryEndScreen(handle, "vidR4", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: "edcr vs doogile · MCSR Ranked",
  });
  assert.deepEqual(realRivalry, {
    outcome: "imported",
    layout: "rivalry",
    video: "specific",
    playlist: true,
    subscribe: true,
  });
  assert.equal(await page.evaluate("window.__endscreenSaved"), true, "a real run saves the custom layout");
  console.log("OK: a real run places all three elements and saves the same-rivalry layout");

  // A rival video search that finds nothing falls back to "Best for viewer", not an empty
  // element — and no playlistTitle at all skips that element outright rather than search for one.
  uiState.rivalryVideoResults = "none";
  const missedVideo = await addRivalryEndScreen(handle, "vidR5", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: null,
  });
  assert.deepEqual(missedVideo, {
    outcome: "imported",
    layout: "rivalry",
    video: "best-for-viewer",
    playlist: false,
    subscribe: true,
  });
  console.log('OK: a video search with no match falls back to "Best for viewer"');
  uiState.rivalryVideoResults = "match";

  // No rival video at all (a first meeting) goes straight to "Best for viewer" — no search ever
  // opened, so nothing in it is ever clicked.
  const noRival = await addRivalryEndScreen(handle, "vidR6", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: null,
    playlistTitle: null,
  });
  assert.deepEqual(noRival, {
    outcome: "imported",
    layout: "rivalry",
    video: "best-for-viewer",
    playlist: false,
    subscribe: true,
  });
  assert.equal(
    await page.evaluate("window.__rivalryRowClicked"),
    null,
    "no search dialog was ever opened with no rival video to look for",
  );
  console.log("OK: no rival video goes straight to Best for viewer, no search opened");

  // Nothing placeable at all (every toolbar sub-option broken) saves an empty canvas to nobody —
  // falls back to the starter template instead, same as the missing-toolbar case above.
  uiState.rivalryVideoChooserAvailable = false;
  uiState.rivalrySubscribeAvailable = false;
  const allFailed = await addRivalryEndScreen(handle, "vidR7", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: null,
  });
  assert.deepEqual(allFailed, {
    outcome: "imported",
    layout: "starter",
    video: "none",
    playlist: false,
    subscribe: false,
  });
  assert.equal(
    await page.evaluate("window.__starterPicked"),
    true,
    "fell back to the starter card when nothing could be placed",
  );
  console.log("OK: nothing placeable at all falls back to the starter template, never an empty save");
  uiState.rivalryVideoChooserAvailable = true;
  uiState.rivalrySubscribeAvailable = true;

  // Same "no toast is no proof it saved" rule as the starter layout: an error, never "imported".
  uiState.saveConfirms = false;
  const unsavedRivalry = await addRivalryEndScreen(handle, "vidR8", "POQrpE0-5d8", {
    matchId,
    rivalVideoId: "rivalVid123",
    playlistTitle: null,
  });
  uiState.saveConfirms = true;
  assert.ok(
    typeof unsavedRivalry === "object" && "error" in unsavedRivalry,
    `expected an error, got ${JSON.stringify(unsavedRivalry)}`,
  );
  assert.match(unsavedRivalry.error, /never showed "Changes saved"/);
  console.log('OK: a same-rivalry Save with no "Changes saved" is an error, never "imported"');

  // --- Related video (phase 2's own second half, 8 Oct 2026) ---------------------------------
  // checkRelatedVideoPicker only ever checks and reports.
  uiState.relatedVideoLinked = false;
  uiState.relatedResults = "none";
  const emptyRelated = await checkRelatedVideoPicker(handle, "vidShort1", "vASY6MzFRNM", { matchId });
  assert.equal(emptyRelated, "picker-empty");
  assert.equal(
    await page.locator("ytcp-video-pick-dialog").count(),
    0,
    "the picker is closed again once checked, nothing left open",
  );
  console.log('OK: checkRelatedVideoPicker reports "picker-empty" when the search finds nothing');

  uiState.relatedVideoLinked = true;
  const alreadyLinked = await checkRelatedVideoPicker(handle, "vidShort1", "vASY6MzFRNM", { matchId });
  assert.equal(alreadyLinked, "already-linked");
  assert.equal(
    await page.locator("ytcp-video-pick-dialog").count(),
    0,
    "an already-linked Short's picker is never even opened",
  );
  console.log('OK: checkRelatedVideoPicker leaves an already-linked Short alone ("already-linked")');

  // A search actually returning a row: checkRelatedVideoPicker still only ever reports, never
  // picks — linkRelatedVideo below is the one that does.
  uiState.relatedVideoLinked = false;
  uiState.relatedResults = "match";
  uiState.relatedTargetId = "vASY6MzFRNM";
  const foundRelated = await checkRelatedVideoPicker(handle, "vidShort1", "vASY6MzFRNM", { matchId });
  assert.ok(typeof foundRelated === "object" && "error" in foundRelated);
  assert.match((foundRelated as { error: string }).error, /linkRelatedVideo/);
  console.log(
    "OK: checkRelatedVideoPicker reports, rather than guesses, once a search actually returns a row",
  );

  // --- linkRelatedVideo: the mutating half (11 Oct 2026, job 8d7d95a1 — real shape confirmed
  // live against match 13830612's own Short/long-form pair) ----------------------------------
  uiState.relatedVideoLinked = false;
  uiState.relatedResults = "none";
  const linkEmpty = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId });
  assert.equal(linkEmpty, "picker-empty");
  assert.equal(await page.locator("ytcp-video-pick-dialog").count(), 0, "closed again, nothing left open");
  console.log('OK: linkRelatedVideo reports "picker-empty" when the search finds nothing');

  // Results came back, but neither card's thumbnail names the long-form we actually want — never
  // guess at "the first row".
  uiState.relatedResults = "miss";
  const linkMiss = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId });
  assert.equal(linkMiss, "not-found");
  assert.equal(await page.locator("ytcp-video-pick-dialog").count(), 0);
  console.log(
    'OK: linkRelatedVideo reports "not-found" rather than click a row that isn\'t the one asked for',
  );

  uiState.relatedVideoLinked = true;
  const linkAlready = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId });
  assert.equal(linkAlready, "already-linked");
  assert.equal(
    await page.locator("ytcp-video-pick-dialog").count(),
    0,
    "an already-linked Short's picker is never even opened",
  );
  console.log('OK: linkRelatedVideo leaves an already-linked Short alone ("already-linked")');

  // The real pick: a decoy card sits before the right one in DOM order (see relatedCard's own
  // comment) — this must click the one whose thumbnail actually names longformABC12, not the
  // decoy, and must not press the page Save on a dry run.
  uiState.relatedVideoLinked = false;
  uiState.relatedResults = "match";
  uiState.relatedTargetId = "longformABC12";
  const linkDry = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId, dryRun: true });
  assert.equal(linkDry, "linked");
  assert.equal(
    await page.evaluate("window.__relatedRowClicked"),
    "longformABC12",
    "clicked the real row, not the decoy",
  );
  assert.equal(await page.evaluate("window.__tcSaved"), false, "a dry run must never press the page Save");
  console.log("OK: linkRelatedVideo's dry run picks the right row and stops before the page Save");

  const linkReal = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId });
  assert.equal(linkReal, "linked");
  assert.equal(await page.evaluate("window.__relatedRowClicked"), "longformABC12");
  assert.equal(await page.evaluate("window.__tcSaved"), true, "a real run must press the page Save");
  const linkShots = readdirSync(path.join(media, String(matchId))).filter((f) =>
    f.startsWith("studio-related-"),
  );
  assert.ok(linkShots.length >= 2, `expected search/picked/after screenshots, got: ${linkShots.join(", ")}`);
  console.log("OK: a real run clicks the matching row and presses the page Save");

  // Same for the related link: no toast is an error, never "linked" (which the ledger keeps for good).
  uiState.saveConfirms = false;
  const unsavedLink = await linkRelatedVideo(handle, "vidShort1", "longformABC12", { matchId });
  uiState.saveConfirms = true;
  assert.equal(await page.evaluate("window.__tcSaved"), true, "the page Save was pressed");
  assert.ok(
    typeof unsavedLink === "object" && "error" in unsavedLink,
    `expected an error, got ${JSON.stringify(unsavedLink)}`,
  );
  assert.match(unsavedLink.error, /never showed "Changes saved"/);
  console.log('OK: a related-link Save with no "Changes saved" is an error, never "linked"');

  // startTestAndCompare: refuses before this point are covered by studioWorker.test.ts (a poisoned
  // handle that never reaches a page at all); here the dialog is real, so this is the rest of the
  // flow — filling the right chip's fields, dry run stopping before Set test, a real run clicking it,
  // and refusing outright when the dialog shows no fresh "set up a test" form (already running).
  uiState.abTest = "none";
  const dryTitle = await startTestAndCompare(
    handle,
    "vidT1",
    {
      kind: "title",
      titles: ["DECIDED BY 1 SECOND | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun"],
    },
    { matchId, dryRun: true, players },
  );
  assert.equal(dryTitle, "started");
  assert.equal(await page.evaluate("window.__tcStarted"), null, "a dry run must never click Set test");
  assert.equal(await page.evaluate("window.__tcSaved"), false, "a dry run must never reach page Save either");
  console.log("OK: startTestAndCompare's dry run fills the title chip and stops before Set test");

  const realTitle = await startTestAndCompare(
    handle,
    "vidT1",
    {
      kind: "title",
      titles: ["DECIDED BY 1 SECOND | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun"],
    },
    { matchId, players },
  );
  assert.equal(realTitle, "started");
  assert.deepEqual(await page.evaluate("window.__tcStarted"), {
    kind: "title",
    title2: "DECIDED BY 1 SECOND | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
  });
  // Live run, 8 Oct 2026: Set test alone left an earlier real attempt unsaved and invisible on
  // reload — page Save is what actually commits it (see SELECTORS.pageSaveButton).
  assert.equal(await page.evaluate("window.__tcSaved"), true, "a real run must also click page Save");
  console.log("OK: a real run picks the Title chip, fills the challenger slot, Set test and page Save");

  const thumbA = path.join(media, "thumb-a.png");
  const thumbB = path.join(media, "thumb-b.png");
  writeFileSync(thumbA, "a");
  writeFileSync(thumbB, "b");
  const realThumb = await startTestAndCompare(
    handle,
    "vidT2",
    { kind: "thumbnail", files: [thumbA, thumbB] },
    { matchId },
  );
  assert.equal(realThumb, "started");
  console.log("OK: a thumbnail test picks the Thumbnail chip and uploads both files");

  // A Save that never confirms is an error, not "started": the worker leaves the experiment
  // planned and records the cycle's error instead of finding a blank form a day later.
  uiState.saveConfirms = false;
  const unsaved = await startTestAndCompare(
    handle,
    "vidT3",
    { kind: "thumbnail", files: [thumbA, thumbB] },
    { matchId },
  );
  uiState.saveConfirms = true;
  assert.equal(await page.evaluate("window.__tcSaved"), true, "Save was pressed");
  assert.ok(
    typeof unsaved === "object" && "error" in unsaved,
    `expected an error, got ${JSON.stringify(unsaved)}`,
  );
  assert.match(unsaved.error, /never showed "Changes saved"/);
  console.log('OK: a Save with no "Changes saved" is an error, never "started"');

  uiState.abTest = "running";
  const already2 = await startTestAndCompare(
    handle,
    "vidT1",
    { kind: "title", titles: ["ANOTHER HOOK | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun"] },
    { matchId, players },
  );
  assert.ok(typeof already2 === "object" && "error" in already2);
  assert.match((already2 as { error: string }).error, /already be set up/);
  console.log(
    "OK: startTestAndCompare refuses to touch a video with no fresh test form (one may be running)",
  );

  // A finished report (22 Oct 2026): its "New test" button is clicked, screenshot taken, and the
  // fresh form behind it is filled exactly as a fresh dialog's — here a dry run, so it stops there.
  uiState.abTest = "finished";
  const overReport = await startTestAndCompare(
    handle,
    "vidT4",
    { kind: "thumbnail", files: [thumbA, thumbB] },
    { matchId, dryRun: true },
  );
  assert.equal(overReport, "started", `expected the fresh form behind New test, got ${JSON.stringify(overReport)}`);
  assert.equal(await page.evaluate("window.__newTestClicked"), true, "New test was clicked");
  assert.equal(await page.evaluate("window.__newTestConfirmed"), true, "the 'Start a new experiment?' confirm was answered Continue");
  assert.ok(
    readdirSync(path.join(media, String(matchId))).some((f) => f.startsWith("studio-tc-new-test-confirm")),
    "the confirm dialog was screenshotted",
  );
  assert.equal(await page.evaluate("window.__tcStarted"), null, "a dry run still never clicks Set test");
  const reportShots = readdirSync(path.join(media, String(matchId))).filter((f) =>
    f.startsWith("studio-tc-finished-report"),
  );
  assert.ok(reportShots.length >= 1, `expected a tc-finished-report screenshot, got: ${reportShots.join(", ")}`);
  console.log("OK: a finished report's New test is clicked (screenshot taken) and the fresh form behind it filled");

  // New test clicked but nothing followed (a wrapper that swallows the click, a form past 15s):
  // a distinct error naming the screenshot, never "a test may already be set up".
  uiState.abTest = "finished";
  uiState.newTestDead = true;
  const deadNewTest = await startTestAndCompare(
    handle,
    "vidT4",
    { kind: "thumbnail", files: [thumbA, thumbB] },
    { matchId, dryRun: true },
  );
  uiState.newTestDead = false;
  assert.ok(typeof deadNewTest === "object" && "error" in deadNewTest);
  assert.match((deadNewTest as { error: string }).error, /New test was clicked.*tc-finished-report/);
  console.log("OK: a New test click that shows no form is its own error, naming the screenshot");

  // A report with no New test button (the 11 Oct shape) is still the existing error, never a guess.
  uiState.abTest = "done";
  const noButton = await startTestAndCompare(
    handle,
    "vidT4",
    { kind: "thumbnail", files: [thumbA, thumbB] },
    { matchId, dryRun: true },
  );
  assert.ok(typeof noButton === "object" && "error" in noButton);
  assert.match((noButton as { error: string }).error, /already be set up/);
  console.log("OK: a dialog with neither a fresh form nor a New test button is still an error");

  // readTestAndCompare: the one confidently-read state ("none"), then the two best-effort ones.
  uiState.abTest = "none";
  const readNone = await readTestAndCompare(handle, "vidT1");
  assert.deepEqual((readNone as { state: string }).state, "none");

  uiState.abTest = "running";
  const readRunning = await readTestAndCompare(handle, "vidT1");
  assert.equal((readRunning as { state: string }).state, "running");

  uiState.abTest = "done";
  const readDone = await readTestAndCompare(handle, "vidT1");
  assert.equal((readDone as { state: string }).state, "done");
  assert.deepEqual((readDone as { shares?: number[] }).shares, [41.5, 58.5]);
  assert.equal((readDone as { winnerSlot?: number }).winnerSlot, 2);
  assert.equal((readDone as { finished?: boolean }).finished, true, "a finished report says so");
  assert.equal((readRunning as { finished?: boolean }).finished, undefined);
  console.log(
    'OK: readTestAndCompare reads "none" confidently and "running"/"done" as its documented best effort',
  );
} finally {
  await handle.stop();
  assert.equal(isRunning(), false, "the lock must clear once the browser actually stops");
  config.mediaDir = mediaDir;
  config.youtubeChannelHandle = channelHandle;
  rmSync(media, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(profileDir2, { recursive: true, force: true });
}
console.log("studioActions: all checks passed");
