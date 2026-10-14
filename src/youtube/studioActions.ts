/**
 * Clicks a real browser makes, because there is no API for them. Phase 1: pin the channel's own
 * comment. Phase 2/3 (8 Oct 2026, `handbook/knowledge/studio-automation-plan-2026-09-28.md`'s own
 * phases, built from a read-only exploration of the real UI the same day — see CLAUDE.md's
 * "Studio automation" section for which selectors below that exploration actually confirmed, and
 * which are a best-effort guess because no end screen or running test was ever seen live): an end
 * screen from the operator's own template, and a Test & Compare (YouTube's own name on this
 * channel for what the plan calls Test & Compare). Selectors in one block, so a Studio/YouTube
 * markup change is a one-line fix rather than a hunt through the functions below.
 */
import { existsSync } from "node:fs";
import { describeError } from "../errorText.js";
import { config } from "../config.js";
import { hookLabelProblem, spoilsTheResult } from "../pipeline/hooks.js";
import { HOOK_MAX_CHARS, hookProblem } from "../shorts/videoPick.js";
import { TITLE_MAX_CHARS } from "../shorts/shortHook.js";
import { splitTitle } from "./youtubeStore.js";
import { page as pageOf, shot, type StudioHandle } from "./studioBrowser.js";

/** Every selector the three flows need. Role/text locators first; the element names below are
 * the fallback a Studio markup change breaks first.
 *
 * `endscreen*` and `abTest*` are from the 7 Oct 2026 exploration (`s7r-*` screenshots/dumps,
 * `tmp/studio2/`): confirmed live on two real videos. `endscreenPickerRow` and the A/B dialog's
 * input fields are NOT confirmed — neither sample video had an end screen or a running test, so
 * there is nothing live to have read a selector off. Treat those two as a best-effort guess to
 * replace the moment a real one is seen (`addEndScreenFromTemplate`/`startTestAndCompare` below
 * say so again at the point each is used). */
const SELECTORS = {
  commentsOff: "text=/Comments are turned off/i",
  commentThread: "ytd-comment-thread-renderer",
  authorLink: "#author-text",
  pinnedBadge: "text=/Pinned by/i",
  actionMenuButton: 'button[aria-label="Action menu"]',
  pinMenuItem: 'tp-yt-paper-item:has-text("Pin")',
  confirmPinButton: 'ytd-button-renderer:has-text("Pin") button, button:has-text("Pin")',
  // End screens — confirmed live 7 Oct 2026.
  endscreenEditorLink: "#endscreen-editor-link",
  // The starter-template gallery only renders while the editor has no elements yet (both sample
  // videos, neither configured) — its presence is the one signal this exploration actually saw
  // for "empty". Its absence is read as "has elements", the safe direction to be wrong in: never
  // import over something someone set by hand (rail 2).
  endscreenEmptyGallery: 'text="1 video, 1 subscribe"',
  // Confirmed live 8 Oct 2026, same raw dump as Save/Discard above (`s7r-endscreen-open.json`):
  // the real clickable id is the `ytcp-button` wrapper's own, not the plain-text selector this
  // used before — the same nested-wrapper double-match risk that comment already explains for
  // Save/Discard applies here too, so this is the confirmed id alone, no text fallback.
  endscreenImportButton: "#import-endscreen-from-video-button",
  endscreenPickerDialog: "ytcp-video-pick-dialog",
  endscreenPickerInput: "ytcp-video-pick-dialog input",
  endscreenPickerNoResults: "text=/No matching results/i",
  // Unconfirmed: no picker search here ever returned a result to click (see the exploration's own
  // "Finding" — the picker's creator-API call resolves to the wrong channel on this profile).
  endscreenPickerRow: 'ytcp-video-pick-dialog ytcp-video-row, ytcp-video-pick-dialog [role="option"]',
  // Confirmed live 8 Oct 2026 from the raw DOM dump the 7 Oct exploration already took
  // (`s7r-endscreen-open.json` and its two picker-state siblings): a plain `button:has-text("Save")`
  // matches TWO elements on this page, not one — the Details page's own page-level Save (also
  // reachable as `pageSaveButton`, `#save`) sits in the DOM *before* the end-screen editor's own,
  // so `.first()` on that text selector would have clicked the wrong one, silently saving nothing
  // the import had actually done. The dump's `ytcp-button` wrapper elements carry real ids the
  // plain `<button>` elements captured alongside them do not: `#save-button`/`#discard-button` are
  // the editor's own, distinct from the page-level `#save`/`#discard` ("Undo changes") — unique in
  // every captured state (the editor just opened, the picker open with and without results).
  endscreenSaveButton: "#save-button",
  endscreenDiscardButton: "#discard-button",
  // Confirmed live 8 Oct 2026 (LUI5E7yF0zE): the A/B Testing dialog's own Close is a
  // ytcp-icon-button, not a <button> — the plain `button[aria-label="Close"]` form never matched
  // it at all, so `.first()` kept resolving to one of the other, unrelated, hidden Close buttons
  // elsewhere in Studio's SPA (there is always at least one on a Details page) and waiting on it
  // forever. Both forms are listed so either real Studio dialog is found.
  // :visible rather than relying on .first()'s DOM order: a Details page always carries at least
  // one other, unrelated, hidden Close element (confirmed), so the first DOM match is not
  // reliably the real open dialog's own.
  dialogClose: 'button[aria-label="Close"]:visible, ytcp-icon-button[aria-label="Close"]:visible',
  // A/B Testing ("Test & Compare" in the plan) — confirmed live 7 Oct 2026.
  abTestButton: "#ab-test-button",
  abTestChipTitle: "#chip-0",
  abTestChipThumbnail: "#chip-1",
  abTestSetButton: "#set-test-button",
  // Confirmed live 8 Oct 2026: "Set test" only stages the test inside the dialog — the banner
  // "The test is ready and will start once you save your changes" appears, and the test does not
  // actually start until the Details page's own Save button is pressed too (the same one that
  // saves a title/description edit). Without it, reopening the video later shows a blank, unset
  // A/B Testing form again, as if nothing had happened.
  pageSaveButton: "#save",
  // Confirmed live 8 Oct 2026 (LUI5E7yF0zE, dry-run): the dialog's own element is
  // ytcp-creator-experiment-create-dialog, not ytcp-ab-test-dialog (that tag does not exist on
  // the page at all — the earlier selectors matched zero elements, title or thumbnail, so a real
  // run would have clicked Set test with nothing actually filled in). Title fields are
  // contenteditable divs, not <input>/<textarea> — "Add title 1"/"2"/"3" by aria-label, slot 1
  // holding the live title already. Thumbnail fields are real <input type="file"> (3, accepting
  // image/jpeg,image/png), slot 1 pre-filled from the live thumbnail, nested under
  // ytcp-thumbnail-uploader — scoped to the dialog root so this can never touch the Details page's
  // own thumbnail input sitting just outside it (confirmed 4 file inputs exist on the page
  // unscoped, only 3 of them inside this dialog).
  abTestTitleInputs: 'ytcp-creator-experiment-create-dialog [aria-label^="Add title"]',
  abTestFileInputs: 'ytcp-creator-experiment-create-dialog input[type="file"]',
  // Related video (phase 2's own second half, 8 Oct 2026 — `tmp/studio3/`, read-only, no
  // Save ever pressed): the Details-page sidebar row below Subtitles. Confirmed live: clicking
  // it opens the *exact same* `ytcp-video-pick-dialog` the end-screen "Import from video" button
  // above already does — same dialog, same search-then-"No matching results" selectors, same
  // confirmed account-scoping bug. `dialogClose` (above) is also confirmed live for this one:
  // unlike the end-screen panel, this dialog closes clean on it, no discard prompt.
  relatedVideoTrigger: "ytcp-text-dropdown-trigger#linked-video-editor-link",
  // The trigger's own `innerText()` is "Related video\nNone" on a real page — a `label-text` div
  // ("Related video") sits alongside the value — confirmed live 8 Oct 2026 via `outerHTML`
  // (`tmp/studio3/`) after a first live run misread that whole string against `/^none$/i` and
  // reported a never-linked Short "already-linked". The value alone lives in its own child,
  // `span.dropdown-trigger-text`; read that, not the trigger's whole text.
  relatedVideoValue: "ytcp-text-dropdown-trigger#linked-video-editor-link .dropdown-trigger-text",
  // Confirmed live 11 Oct 2026 (job 8d7d95a1, read-only: open, search, dump, close — no row ever
  // clicked), once the channel-switch fix above made the picker actually return a row: each result
  // is a `ytcp-entity-card[role="option"]` inside `#videos .videos[role="listbox"]`, scoped to the
  // dialog root so this can never match a row from some other picker instance. There is no plain
  // `<a href>` naming the video — the one place its id appears on the card at all is its own
  // thumbnail's `background-image: url(".../vi/<id>/...")`, which `relatedVideoPickerRowFor` below
  // filters on; `aria-label` carries the title plus ", Not selected"/", Selected" but never the id.
  // The dialog's own `<div class="footer">` is empty — no "Select"/"Insert" button exists at all —
  // so picking a row is the dialog's only confirm step; whether it also closes the dialog on its
  // own is what `linkRelatedVideo` below checks for itself rather than assume.
  relatedVideoPickerRows: 'ytcp-video-pick-dialog ytcp-entity-card[role="option"]',
};

/** The one result row whose own thumbnail names `videoId` — never "the first row" (a search can
 * return more than one video). YouTube's thumbnail URLs are always `.../vi/<id>/<size>.jpg`, so a
 * delimited match on that path segment is exact; nothing on the card names the video any other
 * way (see `SELECTORS.relatedVideoPickerRows`'s own comment). Exported so `linkRelatedVideo`'s
 * "which row" logic has a plain, browser-free unit test of its own selector string. */
export function relatedVideoPickerRowFor(page: import("playwright").Page, videoId: string) {
  return page
    .locator(SELECTORS.relatedVideoPickerRows)
    .filter({ has: page.locator(`.thumbnail[style*="/vi/${videoId}/"]`) });
}

/**
 * Starter-layout gallery card labels, closest to the operator's own template first (CHANNEL/
 * subscribe + 2 VIDEO — "2 videos, 1 subscribe", the task's own phrasing); read live off the real
 * gallery's own on-page text 8 Oct 2026 (`lui-endscreen-text.txt`, LUI5E7yF0zE's End Screens
 * panel): the six cards there read exactly `"1 video, 1 subscribe"` (three of them — apparently
 * different arrangements of the same three elements), `"2 videos"` (two, no subscribe element),
 * and `"1 video, 1 playlist, 1 subscribe"` (one). No card on this channel's gallery reads "2
 * videos, 1 subscribe" outright, so every real attempt today falls through to the second
 * preference. The first preference is kept anyway — a channel or locale where that exact card
 * does exist picks it with no code change — and a plain "2 videos" card (no subscribe element at
 * all) is deliberately not treated as good enough: it is a different composition from the
 * template, not a close match of it.
 *
 * No DOM dump of the gallery's own tag/class exists (the exploration never clicked a card — see
 * `addEndScreenFromTemplate`'s own comment), so this matches by the card's exact, highly specific
 * caption text rather than a confirmed selector — the same honesty `endscreenPickerRow` below is
 * already given. `addEndScreenFromTemplate` only ever reaches this while the empty-state gallery
 * is already confirmed visible, so which panel is open is never in doubt even without a container
 * selector to scope a locator to.
 */
export const STARTER_LAYOUT_PREFERENCE = ["2 videos, 1 subscribe", "1 video, 1 subscribe"] as const;

/** Pure: which of `STARTER_LAYOUT_PREFERENCE` to use, given which of them are actually visible on
 * the page right now — exported so the preference order itself has a plain unit test with no
 * browser (`studioWorker.test.ts`); `clickStarterLayout` below is the thin IO wrapper that answers
 * "visible" from the real page and does the actual click. */
export function pickStarterLayoutLabel(visibleLabels: ReadonlySet<string>): string | null {
  return STARTER_LAYOUT_PREFERENCE.find((label) => visibleLabels.has(label)) ?? null;
}

export type PinOutcome = "pinned" | "already-pinned" | "no-channel-comment" | "skipped-private";

const randomPause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 4000));

/** Studio's buttons are `ytcp-button`s that grey out with `aria-disabled`/`disabled` attributes,
 *  which Playwright's own actionability check does not read — so wait for them by hand. Throws
 *  after `timeoutMs`, which the caller's catch turns into the attempt's error. */
async function waitForEnabled(
  page: import("playwright").Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [aria, disabled] = await Promise.all([
      el.getAttribute("aria-disabled"),
      el.getAttribute("disabled"),
    ]);
    if (aria !== "true" && disabled === null) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`${selector} stayed disabled for ${Math.round(timeoutMs / 1000)} s`);
}

async function scrollToComments(page: import("playwright").Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (
      await page
        .locator(SELECTORS.commentThread)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(300);
  }
}

/** The thread whose author link names our channel — by id, or by `@handle`. A watch page links a
 * comment's author as `/@handle`, not `/channel/<id>`, so on a watch page the handle is what
 * matches; it is compared as the link's whole last segment, case-insensitively, so a handle that
 * is only a prefix of another ("@Test" vs "@TestHandle") never claims it. */
async function findChannelThread(
  page: import("playwright").Page,
  channelId: string,
  channelHandle?: string,
): Promise<import("playwright").Locator | null> {
  const handlePath = channelHandle ? `/@${channelHandle.replace(/^@/, "")}`.toLowerCase() : null;
  const threads = page.locator(SELECTORS.commentThread);
  const count = await threads.count();
  for (let i = 0; i < count; i++) {
    const thread = threads.nth(i);
    const href = await thread
      .locator(SELECTORS.authorLink)
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (!href) continue;
    if (href.includes(channelId)) return thread;
    if (handlePath && href.split(/[?#]/)[0].toLowerCase().endsWith(handlePath)) return thread;
  }
  return null;
}

/**
 * Finds the channel's own comment on a video's watch page and pins it — never unpins or replaces
 * an existing pin, whoever set it. `dryRun` opens the confirm dialog and screenshots it, then
 * stops before the click that would actually pin anything.
 */
export async function pinComment(
  handle: StudioHandle,
  videoId: string,
  opts: { matchId: number; dryRun?: boolean; channelId?: string; channelHandle?: string },
): Promise<PinOutcome | { error: string }> {
  const channelId = opts.channelId ?? config.youtubeChannelId;
  const channelHandle = opts.channelHandle ?? config.youtubeChannelHandle;
  try {
    const page = await pageOf(handle);
    await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    if (
      await page
        .locator(SELECTORS.commentsOff)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return "skipped-private";

    await scrollToComments(page);
    const haveThreads = await page
      .locator(SELECTORS.commentThread)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!haveThreads) return "no-channel-comment";

    if (
      await page
        .locator(SELECTORS.pinnedBadge)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return "already-pinned";

    const thread = await findChannelThread(page, channelId, channelHandle);
    if (!thread) return "no-channel-comment";

    await thread.scrollIntoViewIfNeeded();
    await thread.hover();
    await shot(handle, opts.matchId, "pin-before");

    await thread.locator(SELECTORS.actionMenuButton).click();
    await randomPause();
    await page.locator(SELECTORS.pinMenuItem).click();
    await randomPause();

    if (opts.dryRun) {
      await shot(handle, opts.matchId, "pin-dry-run");
      return "pinned";
    }

    await page.locator(SELECTORS.confirmPinButton).first().click();
    await shot(handle, opts.matchId, "pin-after");
    return "pinned";
  } catch (err) {
    return { error: describeError(err) };
  }
}

export type EndScreenOutcome = "imported" | "already-has-endscreen" | "picker-empty";

/** Checks each `STARTER_LAYOUT_PREFERENCE` label's visibility, picks one with
 * `pickStarterLayoutLabel`, and clicks it — see that list's own comment for what is and is not
 * confirmed about these cards. Returns whether one was found and clicked (never throws on a miss;
 * no matching card is exactly the expected "none of these labels exist on this gallery" case, not
 * a failure). */
async function clickStarterLayout(page: import("playwright").Page): Promise<boolean> {
  const visible = new Set<string>();
  for (const label of STARTER_LAYOUT_PREFERENCE) {
    if (
      await page
        .getByRole("gridcell", { name: label, exact: true })
        .first()
        .isVisible()
        .catch(() => false)
    )
      visible.add(label);
  }
  const chosen = pickStarterLayoutLabel(visible);
  if (!chosen) return false;
  // Confirmed live 8 Oct 2026 (s7R5FUKU0KQ): a plain `getByText(...)` resolves to the card's own
  // inner `.title` text node, which the card's own `role="gridcell"` ancestor then intercepts
  // every click on — Playwright retried for 30s and timed out, never picking a layout at all. The
  // gridcell is the real clickable element (it carries the card's own click handler and its own
  // `aria-label` mirrors the title text exactly), so this targets it directly instead of a
  // descendant it covers.
  await page.getByRole("gridcell", { name: chosen, exact: true }).first().click();
  return true;
}

/** Clicks the editor's own Save and waits for the same "Changes saved" confirmation
 * `startTestAndCompare` already waits for elsewhere in this file — shared by the starter-layout
 * and "Import from video" paths below, both of which finish the same way once something has
 * actually been picked. */
async function saveEndScreenChange(
  page: import("playwright").Page,
  handle: StudioHandle,
  matchId: number,
): Promise<void> {
  await page.locator(SELECTORS.endscreenSaveButton).first().click();
  await page
    .locator('text="Changes saved"')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await shot(handle, matchId, "endscreen-after");
}

/**
 * Gives `videoId` an end screen — skipped if the editor already shows elements (rail 2: never
 * replaces one someone set by hand; when the empty-state gallery cannot be confirmed either way,
 * this treats the video as already configured, the safe direction to be wrong in). The empty
 * state's own starter-layout gallery (phase 4, 8 Oct 2026) is the primary path: apply the card
 * closest to the operator's own template, save, confirm saved (`clickStarterLayout`,
 * `saveEndScreenChange`) — "Import from video" (the operator's own template, named by id) is now
 * only a fallback for the day the picker's own account-scoping bug (below) is fixed and a search
 * actually returns rows to click; until then it still ends in `"picker-empty"` every time, same
 * as before the starter-layout path existed. `dryRun` stops right after picking a card or a
 * picker row, before the save click that would actually apply it — mirroring `pinComment`'s own
 * dry run.
 *
 * `templateQuery` (default `templateId`) is unverified to find anything at all on this profile
 * right now: the exploration's own test run got "No matching results" for every query it tried,
 * including the raw id, because the picker's own search call resolves against the wrong Google
 * account/channel on this login. That exact outcome is reported as `"picker-empty"` rather than
 * guessed past.
 */
export async function addEndScreenFromTemplate(
  handle: StudioHandle,
  videoId: string,
  templateId: string,
  opts: { matchId: number; dryRun?: boolean; templateQuery?: string },
): Promise<EndScreenOutcome | { error: string }> {
  try {
    const page = await pageOf(handle);
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    await page.locator(SELECTORS.endscreenEditorLink).click();
    // Live run, 8 Oct 2026: the End Screens editor is a full panel, not a dialog with its own
    // `aria-label="Close"` — the only two such elements on the page belong to other, unrelated,
    // hidden dialogs elsewhere in Studio's SPA (confirmed by DOM inspection, not a guess), so a
    // wait on `dialogClose` here timed out every time, editor open or not. "Discard changes" is
    // confirmed live instead (`SELECTORS.endscreenDiscardButton`, already this function's own
    // cleanup click below) — present the moment the panel opens.
    await page
      .locator(SELECTORS.endscreenDiscardButton)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await shot(handle, opts.matchId, "endscreen-opened");

    const empty = await page
      .locator(SELECTORS.endscreenEmptyGallery)
      .first()
      .isVisible()
      .catch(() => false);
    if (!empty) {
      await page
        .locator(SELECTORS.endscreenDiscardButton)
        .first()
        .click()
        .catch(() => {});
      return "already-has-endscreen";
    }

    if (await clickStarterLayout(page)) {
      await randomPause();
      await shot(handle, opts.matchId, "endscreen-starter-picked");
      if (opts.dryRun) {
        await shot(handle, opts.matchId, "endscreen-dry-run");
        await page
          .locator(SELECTORS.endscreenDiscardButton)
          .first()
          .click()
          .catch(() => {});
        return "imported";
      }
      await saveEndScreenChange(page, handle, opts.matchId);
      return "imported";
    }

    // Fallback — see this function's own doc comment above.
    await page.locator(SELECTORS.endscreenImportButton).click();
    await page.locator(SELECTORS.endscreenPickerDialog).waitFor({ state: "visible", timeout: 15_000 });
    await page
      .locator(SELECTORS.endscreenPickerInput)
      .first()
      .fill(opts.templateQuery ?? templateId);
    await randomPause();

    const noResults = await page
      .locator(SELECTORS.endscreenPickerNoResults)
      .first()
      .isVisible()
      .catch(() => false);
    if (noResults) {
      await shot(handle, opts.matchId, "endscreen-picker-empty");
      // Best effort: leave nothing open behind us. The picker dialog sits over the editor panel,
      // neither with a real Close button (above) — "Discard changes" dismisses both at once.
      await page
        .locator(SELECTORS.endscreenDiscardButton)
        .first()
        .click()
        .catch(() => {});
      return "picker-empty";
    }

    await page.locator(SELECTORS.endscreenPickerRow).first().click();
    await randomPause();

    if (opts.dryRun) {
      await shot(handle, opts.matchId, "endscreen-dry-run");
      await page
        .locator(SELECTORS.endscreenDiscardButton)
        .first()
        .click()
        .catch(() => {});
      return "imported";
    }

    await saveEndScreenChange(page, handle, opts.matchId);
    return "imported";
  } catch (err) {
    return { error: describeError(err) };
  }
}

export type RelatedVideoOutcome = "already-linked" | "picker-empty";

/**
 * A Short's "Related video" link (phase 2's own second half, quoted directly in its own 8 Oct
 * 2026 read-only exploration, `tmp/studio3/01-related-video-explore.ts`): never touched, never
 * saved, confirmed live. The control (`SELECTORS.relatedVideoTrigger`) opens the *exact same*
 * `ytcp-video-pick-dialog` `addEndScreenFromTemplate`'s "Import from video" fallback above
 * already drives — same search input, same "No matching results" text — and the same account-
 * scoping bug already confirmed there answers "no" for every query on this profile, title or
 * exact video id alike: the picker's own search call resolves against the operator's personal
 * channel, not the brand one.
 *
 * This only ever checks and reports, by design — it never clicks a returned row or presses the
 * page's own Save. `linkRelatedVideo` below is the mutating version, built 11 Oct 2026 once the
 * channel switch (this file's own top comment) made the picker actually return a row to confirm
 * those selectors against; this function stays as the read-only probe `npm run studio --
 * related` uses from the terminal.
 *
 * Already linked to *anything* (not just `longFormVideoId`) is left alone and reported
 * `"already-linked"` without ever opening the dialog — the same "never replace what's already
 * set" rail `pinComment`/`addEndScreenFromTemplate` already keep.
 *
 * Bug fixed 8 Oct 2026, caught by a second live re-run (not the fixture — see
 * `studioActions.test.ts`'s own note): reading `trigger.innerText()` for this check picks up the
 * control's own "Related video" label alongside the value ("Related video\nNone" on a real,
 * never-linked Short, confirmed live via `outerHTML`), so `/^none$/i` never matched and a Short
 * nothing had ever linked came back `"already-linked"`. The value alone lives in its own child,
 * `span.dropdown-trigger-text` (`SELECTORS.relatedVideoValue`) — read that, not the trigger's
 * whole text.
 */
export async function checkRelatedVideoPicker(
  handle: StudioHandle,
  shortVideoId: string,
  longFormVideoId: string,
  opts: { matchId: number },
): Promise<RelatedVideoOutcome | { error: string }> {
  try {
    const page = await pageOf(handle);
    await page.goto(`https://studio.youtube.com/video/${shortVideoId}/edit?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    const trigger = page.locator(SELECTORS.relatedVideoTrigger).first();
    const current = await page
      .locator(SELECTORS.relatedVideoValue)
      .first()
      .innerText()
      .catch(() => "");
    if (current.trim() && !/^none$/i.test(current.trim())) return "already-linked";

    await trigger.click();
    await page.locator(SELECTORS.endscreenPickerDialog).waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(SELECTORS.endscreenPickerInput).first().fill(longFormVideoId);
    await randomPause();
    await shot(handle, opts.matchId, "related-video-search");

    const noResults = await page
      .locator(SELECTORS.endscreenPickerNoResults)
      .first()
      .isVisible()
      .catch(() => false);
    await page
      .locator(SELECTORS.dialogClose)
      .first()
      .click()
      .catch(() => {});
    if (noResults) return "picker-empty";

    // A row actually came back. This function only ever checks — `linkRelatedVideo` below is
    // the one that clicks it.
    return { error: "the picker returned a result — use linkRelatedVideo/`link-related` to set it" };
  } catch (err) {
    return { error: describeError(err) };
  }
}

export type RelatedLinkOutcome = "linked" | "already-linked" | "picker-empty" | "not-found";

/**
 * Sets a Short's "Related video" to `longFormVideoId` — the mutating half of
 * `checkRelatedVideoPicker` above, built 11 Oct 2026 from a live, read-only dry run against this
 * exact pair (job 8d7d95a1, `tmp/related/`, outerHTML dumps + screenshots, no row ever clicked)
 * once the channel-switch fix made the picker return a result at all.
 *
 * Never replaces an existing link, to anything — the same rail `pinComment`/
 * `addEndScreenFromTemplate`/`checkRelatedVideoPicker` already keep, checked the same way
 * (`SELECTORS.relatedVideoValue`, not the trigger's own text, for the bug that comment explains).
 *
 * The picker's result row has no id/href of its own anywhere in its markup — only its thumbnail's
 * `background-image` names the video (`relatedVideoPickerRowFor`), so this never clicks "the
 * first row": a search that returns results but none naming `longFormVideoId` is `"not-found"`,
 * distinct from `"picker-empty"` (the search found nothing at all).
 *
 * The dialog's own footer is empty (confirmed live, same dry run) — no "Select"/"Insert" button
 * exists, so clicking the row is the only in-dialog confirm step there is. Whether that alone
 * closes the dialog is checked rather than assumed: if it is still open after the click, this
 * closes it by hand the same way `checkRelatedVideoPicker` always does (confirmed live: unlike
 * the End Screens editor, this dialog closes clean, no discard prompt). Either way, nothing is
 * saved to the video until the page's own Save is pressed — confirmed disabled
 * (`aria-disabled="true"`) before any pick, the same `waitForEnabled` wait `startTestAndCompare`
 * already uses for the same button, and the same "Changes saved" toast it waits on after.
 *
 * `dryRun` clicks the row (so a screenshot shows the real pick, same as
 * `addEndScreenFromTemplate`'s own starter-layout dry run) but stops before the page Save that
 * would actually apply it — never reaching Studio's own save means nothing persists, the same
 * guarantee `startTestAndCompare`'s "Set test alone does not start anything" dry run already
 * relies on.
 */
export async function linkRelatedVideo(
  handle: StudioHandle,
  shortVideoId: string,
  longFormVideoId: string,
  opts: { matchId: number; dryRun?: boolean },
): Promise<RelatedLinkOutcome | { error: string }> {
  try {
    const page = await pageOf(handle);
    await page.goto(`https://studio.youtube.com/video/${shortVideoId}/edit?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    // No `.catch(() => "")` here on purpose (silent-failure review, 11 Oct 2026): a failed read
    // of this field must never be treated as "nothing linked yet" — that would fall through to
    // opening the picker and pressing the real page Save below, overwriting whatever was actually
    // set. A genuine read failure throws and the outer try/catch turns it into `{error: ...}`, so
    // the worker logs it and retries a later cycle instead of silently clicking past it.
    const current = (await page.locator(SELECTORS.relatedVideoValue).first().innerText()).trim();
    if (current && !/^none$/i.test(current)) return "already-linked";

    await page.locator(SELECTORS.relatedVideoTrigger).click();
    await page.locator(SELECTORS.endscreenPickerDialog).waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(SELECTORS.endscreenPickerInput).first().fill(longFormVideoId);
    await randomPause();
    await shot(handle, opts.matchId, "related-search");

    const noResults = await page
      .locator(SELECTORS.endscreenPickerNoResults)
      .first()
      .isVisible()
      .catch(() => false);
    if (noResults) {
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
      return "picker-empty";
    }

    const row = relatedVideoPickerRowFor(page, longFormVideoId);
    if ((await row.count()) === 0) {
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
      return "not-found";
    }

    await row.first().click();
    await randomPause();
    await shot(handle, opts.matchId, "related-picked");

    // No confirmed "Select"/"Insert" button exists (the dialog's own footer is empty) — the row
    // click may or may not close the dialog on its own; check rather than assume, same as every
    // other cleanup in this file.
    if (
      await page
        .locator(SELECTORS.endscreenPickerDialog)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
    }

    if (opts.dryRun) {
      await shot(handle, opts.matchId, "related-dry-run");
      return "linked";
    }

    await waitForEnabled(page, SELECTORS.pageSaveButton, 15_000);
    await randomPause();
    await page.locator(SELECTORS.pageSaveButton).click();
    await page
      .locator('text="Changes saved"')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});
    await shot(handle, opts.matchId, "related-after");
    return "linked";
  } catch (err) {
    return { error: describeError(err) };
  }
}

/**
 * The hook-only checks every Test & Compare title variant must already pass. `hookProblem`
 * itself finishes with a `hookLabelProblem` call, so calling both here is belt-and-suspenders
 * against the same rule, not a gap — plus the full line's own `TITLE_MAX_CHARS` ceiling and a
 * direct `spoilsTheResult` read against the whole line, since a result word does not have to sit
 * inside the hook segment to spoil it. Exported so the plan importer (`studioExperiments.ts`) can
 * refuse the same way before ever writing a "planned" experiment nobody could start.
 */
export function titleTestProblem(fullTitle: string, players: readonly { nickname: string }[]): string | null {
  if (fullTitle.length > TITLE_MAX_CHARS) return `over ${TITLE_MAX_CHARS} characters`;
  if (spoilsTheResult(fullTitle)) return "it gives the result away";
  const hook = splitTitle(fullTitle)?.hook ?? fullTitle;
  return hookProblem(hook, HOOK_MAX_CHARS, players) ?? hookLabelProblem(hook, players);
}

export type TcTest = { kind: "title"; titles: string[] } | { kind: "thumbnail"; files: string[] };

export type StartTestOutcome = "started";

/**
 * Starts a Test & Compare run — title-only or thumbnail-only, the two single-variable modes this
 * exploration confirmed (`#chip-0`/`#chip-1`; "Title and thumbnail" is a third mode neither this
 * nor the task asks for). Refuses before ever opening a page when a title fails
 * `titleTestProblem` or a thumbnail file is missing or outside YouTube's own 2-3 slot range —
 * that is the whole point of the check living here rather than left to Studio's own UI.
 *
 * Never starts a second test (rail: "it never starts if a test is already running, and it never
 * stops or applies a test") — if the dialog does not show the plain "set up a new test" chips,
 * this returns an error rather than guess at an unconfirmed "already running" layout.
 *
 * `dryRun` stops after filling the variant(s), before the final `#set-test-button` click that
 * actually starts the test — the input/upload selectors it fills are unverified (the exploration
 * never got this far on either sample video), the one part of this function to confirm against a
 * real test before trusting it in production.
 */
export async function startTestAndCompare(
  handle: StudioHandle,
  videoId: string,
  test: TcTest,
  opts: { matchId: number; dryRun?: boolean; players?: readonly { nickname: string }[] },
): Promise<StartTestOutcome | { error: string }> {
  if (test.kind === "title") {
    if (test.titles.length < 1) return { error: "no title variants given" };
    for (const title of test.titles) {
      const problem = titleTestProblem(title, opts.players ?? []);
      if (problem) return { error: `"${title}": ${problem}` };
    }
  } else {
    if (test.files.length < 2 || test.files.length > 3)
      return { error: `thumbnail test needs 2-3 files, got ${test.files.length}` };
    const missing = test.files.find((f) => !existsSync(f));
    if (missing) return { error: `thumbnail file not found: ${missing}` };
  }

  try {
    const page = await pageOf(handle);
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    await page.locator(SELECTORS.abTestButton).click();
    // Same reasoning as the end-screen dialog above: wait for Close, not the heading text, which
    // the trigger button's own aria-label duplicates.
    await page.locator(SELECTORS.dialogClose).first().waitFor({ state: "visible", timeout: 15_000 });
    await shot(handle, opts.matchId, "tc-opened");

    const settable = await page
      .locator(SELECTORS.abTestSetButton)
      .first()
      .isVisible()
      .catch(() => false);
    if (!settable) {
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
      return {
        error:
          "the dialog did not show a fresh test form — a test may already be set up; check Studio by hand",
      };
    }

    const chip = test.kind === "title" ? SELECTORS.abTestChipTitle : SELECTORS.abTestChipThumbnail;
    await page.locator(chip).click();
    await randomPause();

    if (test.kind === "title") {
      const inputs = page.locator(SELECTORS.abTestTitleInputs);
      // Slot 1 is the live title already — only the challenger slot(s) need filling.
      for (let i = 0; i < test.titles.length; i++) {
        await inputs.nth(i + 1).fill(test.titles[i]!);
        await randomPause();
      }
    } else {
      const inputs = page.locator(SELECTORS.abTestFileInputs);
      for (let i = 0; i < test.files.length; i++) {
        // Slot 1 may or may not need a fresh upload (unconfirmed — the map never saw this far);
        // only set a slot that actually offers a file input.
        const slot = inputs.nth(i);
        if (await slot.count()) await slot.setInputFiles(test.files[i]!);
      }
    }
    await shot(handle, opts.matchId, "tc-filled");

    if (opts.dryRun) {
      await shot(handle, opts.matchId, "tc-dry-run");
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
      return "started";
    }

    // Confirmed live 8 Oct 2026 (the worker's first cycle, vASY6MzFRNM): the thumbnails are still
    // "Uploading…" right after setInputFiles and Set test stays greyed out until they land — a
    // ytcp-button with aria-disabled, which Playwright's click does not treat as disabled, so the
    // click went nowhere, the dialog stayed open and its backdrop then blocked the page's Save.
    await waitForEnabled(page, SELECTORS.abTestSetButton, 120_000);
    await page.locator(SELECTORS.abTestSetButton).click();
    // Set test closes the dialog and only stages the change — it does not actually start until the
    // page's own Save is pressed too (see SELECTORS.pageSaveButton). Skipping this left an earlier
    // live attempt looking like it had started (no error, a screenshot of a closed dialog) when
    // nothing had actually happened: reopening the video later showed a blank, unset form again.
    await page
      .locator("ytcp-creator-experiment-create-dialog")
      .first()
      .waitFor({ state: "hidden", timeout: 30_000 });
    await waitForEnabled(page, SELECTORS.pageSaveButton, 15_000);
    await randomPause();
    await page.locator(SELECTORS.pageSaveButton).click();
    // No toast is no proof it saved: swallowed, a Save that never landed read as "started" and
    // surfaced only a day later as a blank form. As an error the worker records it as this cycle's
    // and leaves the experiment "planned" — the next cycle reads the page before trying again.
    const saved = await page
      .locator('text="Changes saved"')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    await shot(handle, opts.matchId, "tc-after");
    if (!saved)
      return {
        error:
          'Save was pressed but Studio never showed "Changes saved" — the test may not have started; check Studio by hand',
      };
    return "started";
  } catch (err) {
    return { error: describeError(err) };
  }
}

export interface TcReadResult {
  state: "running" | "done" | "none";
  winner?: string;
  raw: string;
  /** Watch time share per variant, in the report's order (slot 1 = the live one before the test). */
  shares?: number[];
  /** 1-based slot of the variant Studio marked the winner, when the report says so unambiguously. */
  winnerSlot?: number;
  /** A title test's variant titles, in the report's order. */
  titles?: string[];
  /** Studio's own line under "A/B Test report": "We have a winner!", "They all performed well", … */
  headline?: string;
}

/**
 * Reads a finished test's "A/B Test report" text (confirmed live 11 Oct 2026 on _2EOkOOX0PQ, the
 * only finished report seen yet): "We have a winner!" … per variant "<m:ss>", "<title>", the
 * channel, "Now visible to all viewers" on the live one, "62.1%", "Watch time share", "Winner"
 * after the winner's share … "Test finished. Ran from …". A winner is taken only from Studio's own
 * "Winner" line, and only when "Now visible to all viewers" doesn't contradict it. "Now visible"
 * alone is not a win: a test with no winner (headline "They all performed well", _358mpZeBqFo_
 * 11 Oct 2026, 50.1% vs 49.9%) leaves the live variant live and marks it the same way.
 * ponytail: two reports seen, both with slot 1 live; a slot-2 win laid out differently gives no
 * winnerSlot rather than a wrong one.
 */
export function parseTcReport(text: string): Pick<
  TcReadResult,
  "shares" | "winnerSlot" | "titles" | "headline"
> & {
  done: boolean;
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const shares: number[] = [];
  const titles: string[] = [];
  let winnerMark: number | undefined;
  let visibleMark: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const share = /^(\d+(?:\.\d+)?)%$/.exec(lines[i]);
    if (share && /^watch time share$/i.test(lines[i + 1] ?? "")) shares.push(Number(share[1]));
    else if (/^winner$/i.test(lines[i]) && shares.length) winnerMark = shares.length;
    else if (/^now visible to all viewers$/i.test(lines[i])) visibleMark = shares.length + 1;
    else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(lines[i]) && lines[i + 1]) titles.push(lines[i + 1]);
  }
  const winnerSlot = visibleMark === undefined || winnerMark === visibleMark ? winnerMark : undefined;
  const headline = lines[lines.findIndex((l) => /^a\/b test report$/i.test(l)) + 1];
  return {
    done: /test finished|we have a winner|results ready|performed/i.test(text),
    shares,
    ...(winnerSlot !== undefined && winnerSlot <= shares.length ? { winnerSlot } : {}),
    ...(titles.length ? { titles } : {}),
    ...(headline && lines.some((l) => /^a\/b test report$/i.test(l)) ? { headline } : {}),
  };
}

function doneFromReport(report: string, fallbackRaw: string): TcReadResult {
  const { shares, winnerSlot, titles, headline } = parseTcReport(report);
  return {
    state: "done",
    raw: report || fallbackRaw,
    ...(headline ? { headline } : {}),
    ...(shares?.length ? { shares } : {}),
    ...(winnerSlot !== undefined
      ? { winnerSlot, winner: titles?.[winnerSlot - 1] ?? `variant ${winnerSlot}` }
      : {}),
    ...(titles ? { titles } : {}),
  };
}

/**
 * Reads a video's A/B Testing state. `"none"` is the plain "set up a new test" form; `"done"` is
 * Studio's own "Results ready"/"Test finished" (confirmed live 11 Oct 2026 — the first build guessed
 * at the word "winner" in the title box and never saw the GF title test finish), read with the
 * report's watch-time shares; `"running"` is everything else. `raw` is always the text read, so a
 * human can check what was classified. Never sets a winner itself: YouTube applies its own, and the
 * worker that calls this only records it (`src/youtube/studioWorker.ts`).
 */
export async function readTestAndCompare(
  handle: StudioHandle,
  videoId: string,
): Promise<TcReadResult | { error: string }> {
  try {
    const page = await pageOf(handle);
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();

    // A TITLE test shows its state inline in the title box ("A/B Testing titles · Running… · <both
    // titles>", confirmed live 9 Oct 2026 on la_h_HmMuF8) and its A/B button opens no dialog, so
    // the dialog path below timed out on every title test. Read the inline box first.
    const titleBox = await page
      .locator("ytcp-video-title")
      .first()
      .innerText({ timeout: 10_000 })
      .catch(() => "");
    if (/A\/B Testing titles/i.test(titleBox)) {
      if (!parseTcReport(titleBox).done) return { state: "running", raw: titleBox };
      // Finished: "A/B Testing titles · Results ready · View test report". The numbers are in the
      // report dialog that link opens. Unreadable, it is still done — the shares are just missing.
      const report = await (async () => {
        await page
          .locator("ytcp-video-title a, ytcp-video-title button, ytcp-video-title [role=button]", {
            hasText: /test report/i,
          })
          .first()
          .click({ timeout: 10_000 });
        const dialog = page.locator("tp-yt-paper-dialog", { hasText: /watch time share/i }).first();
        const text = await dialog.innerText({ timeout: 15_000 });
        await page.keyboard.press("Escape").catch(() => {});
        return text;
      })().catch(() => "");
      return doneFromReport(report, titleBox);
    }

    await page.locator(SELECTORS.abTestButton).click();
    await page.locator(SELECTORS.dialogClose).first().waitFor({ state: "visible", timeout: 15_000 });
    const raw = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    const hasChips = await page
      .locator(SELECTORS.abTestSetButton)
      .first()
      .isVisible()
      .catch(() => false);
    await page
      .locator(SELECTORS.dialogClose)
      .first()
      .click()
      .catch(() => {});

    if (hasChips) return { state: "none", raw };
    if (parseTcReport(raw).done) return doneFromReport(raw, raw);
    return { state: "running", raw };
  } catch (err) {
    return { error: describeError(err) };
  }
}
