import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./matchScore.js";

export interface Config {
  /** Pose name for the left/right player's avatar (overlay + thumbnail); see POSE_CAMERAS in src/avatarUrl.ts. */
  leftPose: string;
  rightPose: string;
  /**
   * Pose pairs rendered as thumbnail variants on every pipeline run, for A/B testing which
   * poses earn clicks. The first entry is what `thumbnail.png` becomes unless you pick another
   * in the dashboard, so keep `leftPose`/`rightPose` first to preserve the current look.
   *
   * Pose names map to NMSR camera settings in `src/avatarUrl.ts` (`POSE_CAMERAS`). Every name
   * here must have an entry there with a distinct silhouette, or the variant renders NMSR's
   * default view — the dashboard flags it as a fallback — and CTR grouped by pose compares a
   * variable that never varied.
   *
   * `hook: false` renders that pair without the title headline. Pose barely moves clicks, so a
   * set that varies only pose cannot answer the question the channel actually has — does text on
   * the thumbnail lift CTR? — and Studio's Test & compare takes three images, one of which should
   * be the text-free control. Keep it off the first entry, which is what `thumbnail.png` becomes.
   */
  thumbnailVariants: Array<{ left: string; right: string; hook?: boolean }>;
  /** Minimum cross-correlation confidence (sync.ts) to trust the refined audio sync offset. */
  syncConfidenceThreshold: number;
  /** VOD trim window: seconds of buffer before/after the estimated match start/end. */
  preRollSec: number;
  postRollSec: number;
  /** Fallback run length (sec) when match.result.time is missing/zero (e.g. forfeits). */
  defaultRunSec: number;
  /** Per-match working directory root. */
  mediaDir: string;
  /**
   * The channel uploads go to. Used to tell your own replies apart from viewers' when deciding
   * which comment threads are still unanswered.
   */
  youtubeChannelId: string;
  /**
   * Standing YouTube Reporting API job producing `channel_reach_basic_a1`, the only source of
   * per-video thumbnail impressions and CTR (see src/youtube.ts).
   */
  youtubeReportingJobId: string;
  /**
   * Playlist every upload is added to, keyed by title rather than id so this stays editable by
   * hand — an id would have to be copied out of Studio after creating the playlist there, which
   * is the manual step this removes. Created on first upload if no playlist of that title
   * exists. Empty string turns the step off.
   */
  youtubePlaylistTitle: string;
  /**
   * The same playlist's public URL (`https://www.youtube.com/playlist?list=...`), linked from
   * every description and Short description once set. This one is an id after all, because the
   * description is written by the pipeline, hours before an upload could resolve the title; copy
   * it from the address bar once the first upload has created the playlist. Empty: no line.
   */
  youtubePlaylistUrl: string;
  /**
   * The competitor whose uploads the suggestion cards are checked against (src/rivalPosts.ts):
   * MCSR Matches posts the same matches this channel picks, a day later, to 37x the
   * subscribers. A matchup it has already covered is flagged on the card and ordered after the
   * fresh ones. Empty string turns the check off; it also needs the YouTube token.
   */
  rivalChannelHandle: string;
  /**
   * A tip-jar URL (Ko-fi, PayPal.me) for the description's "Support the channel" line. The
   * audit named it the one revenue stream not gated at 41 subscribers, and the active
   * competitor runs a PayPal.me link in every description. Empty: no line.
   */
  supportUrl: string;
  /**
   * Where the PC that publishes pulls finished files *from*, as an rsync/ssh target — e.g.
   * `homelab@actimel:/home/homelab/mcsr-media`, which is this container's `/media` seen from
   * the lab host (compose bind mount), not the container path. A pull target, not a push (see
   * src/publishSet.ts). Empty string hides the publish kit's pull block; nothing here is ever
   * executed by the server.
   */
  pullSource: string;
  /** Where those files land on the PC. `~` is expanded by the operator's own shell. */
  pullDest: string;
  /**
   * Seconds of overlay before the RTA timer starts.
   *
   * This is also where the published video begins: the timeline is anchored on the world-load
   * thump (kdenliveProject.ANCHOR_SEC), so an overlay lead-in equal to that anchor puts the
   * overlay, the intro and the footage all at timeline 0 with nothing trimmed. Changing it
   * away from 10 makes the overlay clips get head-trimmed to keep match start in place, which
   * is correct but wastes render, and an intro shorter than the difference is rejected outright.
   *
   * The VOD clips keep a much larger `preRollSec` because the audio-sync search needs room to
   * hunt for the thump; that headroom is trimmed off the timeline rather than shown.
   */
  overlayLeadInSec: number;
  /**
   * Frame rate of the overlay render. The overlay is 2D graphics composited over 60fps
   * footage, so 30 halves render time and file size for no visible loss; raise to 60 only
   * if you can see the RTA timer's millisecond digits stepping.
   */
  overlayFps: number;
  /**
   * Parallel browser tabs used to render frames. null = Remotion's default,
   * round(min(8, cores/2)) — 2 on the lab. Remotion caps this at the core count.
   */
  renderConcurrency: number | null;
  /**
   * Hour of day (UTC, 0-23) at which the dashboard starts one render by itself, or null to
   * never. 3 is 05:00 in Poland: the lab is idle, and a render that runs unattended is finished
   * long before anyone looks, which is the whole point — the bottleneck on output is operator
   * minutes, not compute, so the morning question becomes "publish this?" with a preview
   * rather than "render this?" with a chart. See src/nightly.ts for what it will and won't do.
   */
  nightlyRenderHourUtc: number | null;
  /**
   * Whether a clean nightly render is followed by a Short of the same match, cut with the top
   * moment (`--pick=0`). On by default: the VODs are already on disk, the cut costs a couple of
   * minutes next to the render itself, and Shorts are the only surface on the channel that
   * reaches people who have never heard of it. Only `done` chains one — a failed or aborted
   * pipeline has nothing to cut from, and an abort is the operator saying stop.
   */
  nightlyRenderShort: boolean;
  /**
   * Whether a clean nightly render is also encoded to a finished MP4 (`npm run export:fast`,
   * ~10 minutes for a 10-minute match on the lab's VAAPI). On by default, because the render
   * alone leaves a project and overlays: nothing to watch in the preview and nothing to upload,
   * so the morning would still open on a ten-minute wait. Off when every match is cut by hand
   * in Kdenlive first — the export would be of the uncut project.
   */
  nightlyRenderExport: boolean;
  /**
   * Where to POST a one-line plain-text result when a nightly render settles — an ntfy.sh topic
   * URL takes exactly that body, which is why the body is plain text and nothing else. Empty
   * string turns the notification off; a failed POST is logged, never fatal.
   */
  nightlyNotifyUrl: string;
  /**
   * The hour (UTC, 0-23) the publish kit proposes for "Publish at", and the upload form's
   * default. 19 is the active competitor's measured slot — 36 of its last 50 uploads on the
   * dot, median 4.2k views there against 1.6k for its earlier 17:xx uploads — and 21:00 in
   * Poland, 15:00 on the US east coast. See src/publishSlot.ts.
   */
  publishHourUtc: number;
  /**
   * Whether the bottom band's meta column turns into a subscribe card a few seconds after the
   * finish, for the post-roll. Subscribers are the binding Partner Programme gate (500; the
   * hours gate levels off under 4,000 at any cadence this channel can run), and the post-roll
   * is where 35-69% of viewers are still watching with nothing on screen changing. Off keeps
   * the achievements block through the tail.
   */
  postRollCta: boolean;
  /**
   * Suggestion slots per bucket. Close races and entertaining messes are ranked
   * separately so a run of very tight matches can't crowd the funny ones off the list.
   */
  suggestCloseSlots: number;
  suggestChaosSlots: number;
  /** Reuse the cached suggestion list for this long before rescanning. */
  suggestCacheTtlMin: number;
  /**
   * Caps on a single scan. Only ~2% of ranked matches have the two VODs the pipeline
   * needs, so the feed is paged (100 matches per request) until enough candidates turn
   * up; each survivor then costs one more request for its timeline. Worst case here is ~160
   * requests (120 detail fetches plus ~40 feed pages) against a 500-per-10-minute budget.
   */
  suggestMaxScanRequests: number;
  suggestDetailFetchLimit: number;
  /**
   * Speed scoring: a run at or under `fast` earns the full bonus, decaying to nothing at
   * `slow`. Deliberately only one term among several — the best-performing video so far
   * was a 10:22 that won on a one-second finish.
   */
  suggestFastRunTargetSec: number;
  suggestSlowRunCutoffSec: number;
  /**
   * How much a player's Twitch following counts toward "popular", on top of how often
   * they turn up streaming ranked matches. Applied to `log10(1 + followers)` because
   * follower counts are heavy-tailed: at weight 3, 1k followers is worth ~9 and 100k
   * ~15, comparable to the range raw appearance counts span. Needs
   * `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`; without them popularity is
   * appearances-only and this is ignored.
   */
  suggestFollowerWeight: number;
  /** Per-term weights for the closeness and chaos scores. */
  suggestWeights: ScoreWeights;
}

const DEFAULTS: Config = {
  leftPose: "walking",
  rightPose: "crossed",
  thumbnailVariants: [
    // First is the existing look, so nothing changes for a match already published.
    { left: "walking", right: "crossed" },
    { left: "cheering", right: "relaxing" },
    // The control: same layout, no headline, so the A/B set varies text and not just pose.
    { left: "marching", right: "crouching", hook: false },
  ],
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  postRollSec: 60,
  defaultRunSec: 900,
  mediaDir: "media",
  youtubeChannelId: "UCm2mAyONTHlmIxZzNmi388w",
  youtubeReportingJobId: "eda017ae-a539-4c79-8e2c-66d1af74264a",
  youtubePlaylistTitle: "MCSR Ranked matches",
  youtubePlaylistUrl: "",
  rivalChannelHandle: "mcsrmatches",
  supportUrl: "",
  pullSource: "",
  pullDest: "~/Replayoffs",
  overlayLeadInSec: 10,
  overlayFps: 30,
  renderConcurrency: null,
  nightlyRenderHourUtc: 3,
  nightlyRenderShort: true,
  publishHourUtc: 19,
  postRollCta: true,
  nightlyRenderExport: true,
  nightlyNotifyUrl: "",
  suggestCloseSlots: 8,
  suggestChaosSlots: 2,
  suggestCacheTtlMin: 30,
  suggestMaxScanRequests: 40,
  // Only ~10% of dual-VOD matches have a comparable finish (usually the loser stops once the
  // winner is done), so filling eight close slots needs a shortlist well past eight.
  suggestDetailFetchLimit: 120,
  suggestFastRunTargetSec: 420,
  suggestSlowRunCutoffSec: 600,
  suggestFollowerWeight: 3,
  suggestWeights: DEFAULT_WEIGHTS,
};

const CONFIG_PATH = path.resolve("mcsr-vid.config.json");

/**
 * The config file is hand-edited, so a wrong type (`"renderConcurrency": "4"`) would otherwise be
 * spread straight into `Config` and surface far from the cause — as string concatenation in slot
 * arithmetic, or a bad option handed to the Remotion renderer. Check each override against the
 * type of the default it replaces and fail here, naming the key.
 */
export function validateOverrides(raw: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) {
      throw new Error(`${CONFIG_PATH}: unknown key "${key}".`);
    }
    const expected = DEFAULTS[key as keyof Config];
    if (key === "suggestWeights") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${CONFIG_PATH}: "suggestWeights" must be an object.`);
      }
      for (const [wKey, wValue] of Object.entries(value)) {
        if (!(wKey in DEFAULTS.suggestWeights)) {
          throw new Error(`${CONFIG_PATH}: unknown suggestWeights key "${wKey}".`);
        }
        if (typeof wValue !== "number" || !Number.isFinite(wValue)) {
          throw new Error(`${CONFIG_PATH}: suggestWeights."${wKey}" must be a finite number.`);
        }
      }
      continue;
    }
    // Its default is an hour, but null is the documented "no nightly render", and a number
    // outside the clock would pass a type check: `setUTCHours(25)` rolls into the next day
    // without a word, so a mistyped hour would fire at 01:00 and look scheduled.
    if (key === "nightlyRenderHourUtc" || key === "publishHourUtc") {
      const nullable = key === "nightlyRenderHourUtc";
      if (
        (value === null && !nullable) ||
        (value !== null && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23))
      ) {
        throw new Error(
          `${CONFIG_PATH}: "${key}" must be a whole hour 0-23 (UTC)${nullable ? ", or null" : ""}.`,
        );
      }
      continue;
    }
    // A key whose default is null and whose override is a number: renderConcurrency (null =
    // Remotion's own default). `typeof null` is "object", so it has to be checked before the
    // typeof comparison below.
    if (expected === null) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be a finite number or null.`);
      }
      continue;
    }
    if (typeof value !== typeof expected) {
      throw new Error(
        `${CONFIG_PATH}: "${key}" must be a ${typeof expected}, got ${value === null ? "null" : typeof value}.`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${CONFIG_PATH}: "${key}" must be a finite number.`);
    }
  }
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object.`);
  }
  const raw = parsed as Record<string, unknown>;
  validateOverrides(raw);
  return {
    ...DEFAULTS,
    ...raw,
    // The spread above is shallow, so overriding one weight would drop all the others.
    suggestWeights: {
      ...DEFAULTS.suggestWeights,
      ...((raw.suggestWeights as Partial<ScoreWeights>) ?? {}),
    },
  } as Config;
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();

/** Every match's working directory: `<mediaDir>/<id>`. */
export const matchDir = (matchId: number): string => path.join(config.mediaDir, String(matchId));
