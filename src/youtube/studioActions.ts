/**
 * Clicks a real browser makes, because there is no API for them. Phase 1: pin the channel's own
 * comment (nothing else here yet). Selectors in one block, so a Studio/YouTube markup change is a
 * one-line fix rather than a hunt through the function below.
 */
import { describeError } from "../errorText.js";
import { config } from "../config.js";
import { page as pageOf, shot, type StudioHandle } from "./studioBrowser.js";

/** Every selector the comment flow needs. Role/text locators first; the element names below are
 * the fallback a Studio markup change breaks first. */
const SELECTORS = {
  commentsOff: "text=/Comments are turned off/i",
  commentThread: "ytd-comment-thread-renderer",
  authorLink: "#author-text",
  pinnedBadge: "text=/Pinned by/i",
  actionMenuButton: 'button[aria-label="Action menu"]',
  pinMenuItem: 'tp-yt-paper-item:has-text("Pin")',
  confirmPinButton: 'ytd-button-renderer:has-text("Pin") button, button:has-text("Pin")',
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
