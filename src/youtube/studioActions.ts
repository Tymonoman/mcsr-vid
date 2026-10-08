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
  endscreenImportButton: 'button:has-text("Import from video")',
  endscreenPickerDialog: "ytcp-video-pick-dialog",
  endscreenPickerInput: "ytcp-video-pick-dialog input",
  endscreenPickerNoResults: "text=/No matching results/i",
  // Unconfirmed: no picker search here ever returned a result to click (see the exploration's own
  // "Finding" — the picker's creator-API call resolves to the wrong channel on this profile).
  endscreenPickerRow: 'ytcp-video-pick-dialog ytcp-video-row, ytcp-video-pick-dialog [role="option"]',
  endscreenSaveButton: 'button:has-text("Save")',
  endscreenDiscardButton: 'button:has-text("Discard changes")',
  dialogClose: 'button[aria-label="Close"]',
  // A/B Testing ("Test & Compare" in the plan) — confirmed live 7 Oct 2026.
  abTestButton: "#ab-test-button",
  abTestChipTitle: "#chip-0",
  abTestChipThumbnail: "#chip-1",
  abTestSetButton: "#set-test-button",
  // Unconfirmed: the dialog never got far enough in this exploration to see its own input/upload
  // fields, or either a running or a finished test's layout.
  abTestTitleInputs: 'ytcp-ab-test-dialog input[type="text"], ytcp-ab-test-dialog textarea',
  abTestFileInputs: 'ytcp-ab-test-dialog input[type="file"]',
};

export type PinOutcome = "pinned" | "already-pinned" | "no-channel-comment" | "skipped-private";

const randomPause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 4000));

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

/** The thread whose author link names our channel — by id, or by `@handle` when given. */
async function findChannelThread(
  page: import("playwright").Page,
  channelId: string,
  channelHandle?: string,
): Promise<import("playwright").Locator | null> {
  const threads = page.locator(SELECTORS.commentThread);
  const count = await threads.count();
  for (let i = 0; i < count; i++) {
    const thread = threads.nth(i);
    const href = await thread
      .locator(SELECTORS.authorLink)
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href && (href.includes(channelId) || (channelHandle && href.includes(channelHandle)))) return thread;
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

    const thread = await findChannelThread(page, channelId, opts.channelHandle);
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

/**
 * Imports the operator's own end-screen template (one video set up by hand, named by id) onto
 * `videoId` — skipped if the editor already shows elements (rail 2: never replaces one someone
 * set by hand; when the empty-state gallery cannot be confirmed either way, this treats the
 * video as already configured, the safe direction to be wrong in). `dryRun` stops right after
 * picking the template in "Import from video", before the save click that would actually apply
 * it — mirroring `pinComment`'s own dry run.
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
    // The dialog's own heading text ("End Screens") also names the trigger's aria-label in real
    // Studio, so this waits for its Close affordance instead — present only once a dialog is open.
    await page.locator(SELECTORS.dialogClose).first().waitFor({ state: "visible", timeout: 15_000 });
    await shot(handle, opts.matchId, "endscreen-opened");

    const empty = await page
      .locator(SELECTORS.endscreenEmptyGallery)
      .first()
      .isVisible()
      .catch(() => false);
    if (!empty) {
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
      return "already-has-endscreen";
    }

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
      // Best effort: leave nothing open behind us, whichever dialog is still up.
      await page
        .locator(SELECTORS.dialogClose)
        .first()
        .click()
        .catch(() => {});
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

    await page.locator(SELECTORS.endscreenSaveButton).first().click();
    await shot(handle, opts.matchId, "endscreen-after");
    return "imported";
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

    await page.locator(SELECTORS.abTestSetButton).click();
    await shot(handle, opts.matchId, "tc-after");
    return "started";
  } catch (err) {
    return { error: describeError(err) };
  }
}

export interface TcReadResult {
  state: "running" | "done" | "none";
  winner?: string;
  raw: string;
}

/**
 * Reads a video's A/B Testing dialog. Only `"none"` (the plain "set up a new test" form, the one
 * state this exploration actually saw live) is confident; `"running"` is everything else, and
 * `"done"` is a best-effort guess at the word "winner" showing up once the set-up chips are gone
 * — unconfirmed, because no test ever ran long enough here to see either layout. `raw` is always
 * the dialog's own text, so a human can read what the heuristic could not classify. Never sets a
 * winner itself: the worker that calls this only ever records YouTube's own (`src/youtube/studioWorker.ts`).
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
    const winnerMatch = /winner[^.\n]*/i.exec(raw);
    if (winnerMatch) return { state: "done", winner: winnerMatch[0].trim(), raw };
    return { state: "running", raw };
  } catch (err) {
    return { error: describeError(err) };
  }
}
