/**
 * A community poll per new long-form (22 Oct 2026, the operator: "yes"): "WHO TAKES IT?" with
 * the two runners as the options and the video link under it — asked, never answered. Nothing
 * here names a winner, a score, a nickname, an elo or a rank: the options are the title's own two
 * names (`titleName`), the text is "<A> vs <B> is up: <link>".
 *
 * Which page: `https://www.youtube.com/channel/<id>/community` — the channel's own Community tab
 * on www.youtube.com, not Studio's "Create → Create post". The pin flow (`pinComment`) already
 * drives www.youtube.com as the brand channel (a pin is owner-only, confirmed live 14 Oct 2026),
 * so the session's active channel there is the right one; the same tab lists the channel's
 * existing posts, which is the "already-posted" check and the after-click confirmation. Studio's
 * composer is the fallback if this tab ever stops offering one.
 *
 * NONE of `SELECTORS` is confirmed live yet: no supervised run has opened this tab. They are
 * best-effort guesses at YouTube's backstage markup, every one guarded — a missing element is a
 * `{ error }` naming it, never a click on something else — and the three screenshots
 * (`community-opened`/`-filled`/`-after`) are what the first supervised run reads them off
 * (handbook/studio-routine.md). Replace them in this one block.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import { titleName } from "../pipeline/title.js";
import { page as pageOf, shot, type StudioHandle } from "./studioBrowser.js";
import { splitTitle } from "./youtubeStore.js";

const SELECTORS = {
  /** The owner's own composer at the top of the Community tab (collapsed until clicked). */
  composer: "ytd-backstage-post-dialog-renderer",
  composerTextBox: 'ytd-backstage-post-dialog-renderer [contenteditable="true"]',
  /** The post-type row's "Poll" (exact text, so "Image poll" never passes for it). */
  pollType: 'ytd-backstage-post-dialog-renderer button, ytd-backstage-post-dialog-renderer [role="button"]',
  /** One text input per option once the poll type is chosen. */
  pollOptionInputs:
    'ytd-backstage-post-dialog-renderer input[type="text"], ytd-backstage-post-dialog-renderer input:not([type])',
  postButton:
    'ytd-backstage-post-dialog-renderer #submit-button button, ytd-backstage-post-dialog-renderer button[aria-label="Post"]',
  /** Every post on the tab, the channel's own included. */
  posts: "ytd-backstage-post-renderer",
};

export const POLL_QUESTION = "WHO TAKES IT?";
/** A long-form that went public longer ago than this is not polled: the poll is for the video's
 *  first day, while the notification and the Home push still bring viewers. */
export const POLL_WINDOW_MS = 36 * 3600_000;
export const MAX_POLLS_PER_CYCLE = 2;
/** A video whose poll failed this many cycles running is left alone and reported (Needs you). */
export const POLL_MAX_FAILURES = 3;

export interface CommunityPoll {
  videoId: string;
  question: string;
  /** Exactly two: the title's left and right names, in the title's order. */
  options: [string, string];
  /** The line under the question, carrying the video link. */
  text: string;
}

/** The poll for a stored title ("<hook> | <A> vs <B> | …"), or null when the title names no pair.
 * Pure: the names are the title's own (`titleName` again is a no-op on an already-spelled one). */
export function pollContentFor(title: string, videoId: string): CommunityPoll | null {
  const parts = splitTitle(title);
  if (!parts) return null;
  const left = titleName(parts.left);
  const right = titleName(parts.right);
  return {
    videoId,
    question: POLL_QUESTION,
    options: [left, right],
    text: `${left} vs ${right} is up: https://youtu.be/${videoId}`,
  };
}

export type PollOutcome = "posted" | "already-posted";

const randomPause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 4000));

/**
 * Opens the channel's Community tab, finds the composer, picks Poll, fills the text and the two
 * options, and posts. `dryRun` fills everything, screenshots it, and stops before the Post click.
 * "already-posted" when a post on the tab already carries this video's link (never a second
 * poll on the same video, whoever posted the first). Live, "posted" only once the new post —
 * the question and the link — shows on the tab; a Post click that shows nothing is an error.
 */
export async function postCommunityPoll(
  handle: StudioHandle,
  poll: CommunityPoll,
  opts: { matchId: number; dryRun?: boolean; channelId?: string },
): Promise<PollOutcome | { error: string }> {
  const channelId = opts.channelId ?? config.youtubeChannelId;
  try {
    const page = await pageOf(handle);
    await page.goto(`https://www.youtube.com/channel/${channelId}/community?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomPause();
    await shot(handle, opts.matchId, "community-opened");

    const posts = page.locator(SELECTORS.posts);
    const withLink = posts.filter({ has: page.locator(`a[href*="${poll.videoId}"]`) });
    if ((await withLink.count()) > 0 || (await posts.filter({ hasText: poll.videoId }).count()) > 0)
      return "already-posted";

    const composer = page.locator(SELECTORS.composer).first();
    if (!(await composer.isVisible().catch(() => false)))
      return {
        error:
          "no community composer on the channel's Community tab (not the channel owner here, or the markup moved)",
      };
    await composer.click();
    await randomPause();

    const pollType = page
      .locator(SELECTORS.pollType)
      .filter({ hasText: /^\s*Poll\s*$/ })
      .first();
    if (!(await pollType.isVisible().catch(() => false)))
      return { error: 'the composer shows no "Poll" post type' };
    await pollType.click();
    await randomPause();

    const inputs = page.locator(SELECTORS.pollOptionInputs);
    const haveOptions = await inputs
      .nth(1)
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!haveOptions) return { error: "the poll editor shows fewer than two option fields" };

    const textBox = page.locator(SELECTORS.composerTextBox).first();
    if (!(await textBox.isVisible().catch(() => false)))
      return { error: "the composer has no text box to type the question into" };
    // Enter, not "\n" in a fill: a contenteditable's insertText drops the newline and runs the
    // question into the link line (fixture, 22 Oct 2026).
    await textBox.fill(poll.question);
    await textBox.press("Enter");
    await page.keyboard.insertText(poll.text);
    await inputs.nth(0).fill(poll.options[0]);
    await inputs.nth(1).fill(poll.options[1]);
    await randomPause();
    await shot(handle, opts.matchId, "community-filled");

    const post = page.locator(SELECTORS.postButton).first();
    if (!(await post.isVisible().catch(() => false))) return { error: "the composer has no Post button" };
    if (opts.dryRun) return "posted";

    await post.click();
    const landed = await posts
      .filter({ hasText: poll.question })
      .filter({ hasText: poll.videoId })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    await shot(handle, opts.matchId, "community-after");
    if (!landed)
      return {
        error: "Post was pressed but the new poll never appeared on the tab — check the channel by hand",
      };
    return "posted";
  } catch (err) {
    return { error: describeError(err) };
  }
}

// ---------------------------------------------------------------------------
// `<mediaDir>/.community-posts.json`: {videoId: {at, outcome, matchId, failures?}}.
// ---------------------------------------------------------------------------

export interface CommunityPostRecord {
  at: string;
  /** "posted" | "already-posted" | "skipped: <why>" | "error: <message>". */
  outcome: string;
  matchId: number;
  /** Consecutive failed attempts; absent once one succeeds. */
  failures?: number;
}

export type CommunityPosts = Record<string, CommunityPostRecord>;

const postsPath = (): string => path.join(config.mediaDir, ".community-posts.json");

/** Sync, like the heartbeat read in `src/telegram/facts.ts`: a missing or corrupt file is empty. */
export function readCommunityPosts(file: string = postsPath()): CommunityPosts {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CommunityPosts) : {};
  } catch {
    return {};
  }
}

/** Read-merge-write of one video's record (atomic rename). A failure counts up `failures`; any
 *  other outcome clears it. */
export function recordCommunityPost(
  videoId: string,
  matchId: number,
  outcome: string,
  now: Date = new Date(),
  file: string = postsPath(),
): CommunityPosts {
  const posts = readCommunityPosts(file);
  const failed = outcome.startsWith("error");
  const failures = failed ? (posts[videoId]?.failures ?? 0) + 1 : undefined;
  posts[videoId] = { at: now.toISOString(), outcome, matchId, ...(failures ? { failures } : {}) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(posts, null, 2));
  renameSync(`${file}.tmp`, file);
  return posts;
}

export interface PollCandidate {
  videoId: string;
  matchId: number;
  title: string;
  /** Live, from this cycle's `videoStats` read — never the upload-time record. */
  privacyStatus: string;
  /** When it went (or goes) public: `publishAt` for a scheduled upload, else `publishedAt`. */
  publicAt: string | null;
}

/**
 * Pure: the long-forms one cycle polls — public now, public within `POLL_WINDOW_MS`, no record
 * yet (a failed one is retried until `POLL_MAX_FAILURES`), not blocked, one per video id, at most
 * `MAX_POLLS_PER_CYCLE`. The DNF check needs the API, so `runCycle` makes it per candidate.
 */
export function pollTargets(
  now: Date,
  videos: readonly PollCandidate[],
  posts: CommunityPosts,
  isBlocked: (matchId: number) => boolean,
): PollCandidate[] {
  const seen = new Set<string>();
  return videos
    .filter((v) => v.privacyStatus === "public")
    .filter((v) => {
      const at = v.publicAt ? Date.parse(v.publicAt) : NaN;
      return Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= POLL_WINDOW_MS;
    })
    .filter((v) => {
      const rec = posts[v.videoId];
      return !rec || (rec.outcome.startsWith("error") && (rec.failures ?? 0) < POLL_MAX_FAILURES);
    })
    .filter((v) => !isBlocked(v.matchId))
    .filter((v) => {
      if (seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    })
    .slice(0, MAX_POLLS_PER_CYCLE);
}

/** Pure: the "Needs you" lines — one per video whose poll has failed `POLL_MAX_FAILURES` times. */
export function pollFailureLines(posts: CommunityPosts): Array<{ matchId: number; text: string }> {
  return Object.entries(posts)
    .filter(([, rec]) => (rec.failures ?? 0) >= POLL_MAX_FAILURES)
    .map(([videoId, rec]) => ({
      matchId: rec.matchId,
      text: `Community poll failed ${POLL_MAX_FAILURES} times: ${rec.outcome.replace(/^error:\s*/, "")} (${videoId})`,
    }));
}
