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
const profileDir2 = mkdtempSync(path.join(tmpdir(), "mcsr-studio-profile2-"));
const { config } = await import("../config.js");
const mediaDir = config.mediaDir;
config.mediaDir = media;

const { isRunning, page: pageOf, start } = await import("./studioBrowser.js");
const {
  pinComment,
  addEndScreenFromTemplate,
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

  // --- End screens + Test & Compare (phase 2/3, 8 Oct 2026) -----------------------------------
  // A fixture for the Details page's two dialogs (End Screens, A/B Testing), mimicking the real
  // UI's own role/id selectors from the 7 Oct 2026 exploration (`uiState` plays the Node-side
  // server; `window.__*` is what a real click would have actually done, read back below).
  const uiState = {
    endScreenHasElements: false,
    pickerHasResults: true,
    abTest: "none" as "none" | "running" | "done",
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
    <button id="save" onclick="window.__tcSaved=true;document.getElementById('saved-msg').style.display='block'">Save</button>
    <div id="saved-msg" style="display:none">Changes saved</div>
    <div id="dialog-root"></div>
    <script>
      window.__state = ${JSON.stringify(uiState)};
      window.__endscreenSaved = false;
      window.__tcStarted = null;
      window.__tcSaved = false;
      window.__starterPicked = false;
      window.__pickerOpened = false;
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
              '<button onclick="window.__pickerOpened=true;openPicker()">Import from video</button>') +
          '<button id="discard-button" onclick="closeDialog()">Discard changes</button>' +
          // Shows the same "Changes saved" toast the page-level Save does (#saved-msg above) —
          // saveEndScreenChange (studioActions.ts) waits on it the same way startTestAndCompare
          // already waits on it for its own page Save.
          '<button id="save-button" onclick="window.__endscreenSaved=true;document.getElementById(\\'saved-msg\\').style.display=\\'block\\';closeDialog()">Save</button></div>';
      }
      function openPicker() {
        document.getElementById("dialog-root").innerHTML +=
          '<ytcp-video-pick-dialog><input oninput="onPickerInput(this.value)" /><div id="picker-results"></div></ytcp-video-pick-dialog>';
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
        } else {
          root.innerHTML = '<div><span>A/B Testing</span><button aria-label="Close" onclick="closeDialog()">Close</button><p>Winner: Thumbnail 2 was applied automatically.</p></div>';
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
  assert.match((readDone as { winner?: string }).winner ?? "", /Thumbnail 2/);
  console.log(
    'OK: readTestAndCompare reads "none" confidently and "running"/"done" as its documented best effort',
  );
} finally {
  await handle.stop();
  assert.equal(isRunning(), false, "the lock must clear once the browser actually stops");
  config.mediaDir = mediaDir;
  rmSync(media, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(profileDir2, { recursive: true, force: true });
}
console.log("studioActions: all checks passed");
