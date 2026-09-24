import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./pipeline/matchScore.js";

export interface Config {
  /** Pose name for the left/right player's avatar (overlay + thumbnail); see POSE_CAMERAS in src/api/avatarUrl.ts. */
  leftPose: string;
  rightPose: string;
  /**
   * Pose pairs rendered as thumbnail variants on every pipeline run, for A/B testing which
   * poses earn clicks. Plain renders only: the hooked twins (`src/thumbnails/thumbnailVariants.ts`) are no
   * longer asked for — the operator took the text off the thumbnails on 18 Sept 2026. The
   * first entry's render is what `thumbnail.png` becomes unless you pick another in the
   * dashboard, so keep `leftPose`/`rightPose` first to preserve the current look.
   *
   * Pose names map to NMSR camera settings in `src/api/avatarUrl.ts` (`POSE_CAMERAS`). Every name
   * here must have an entry there with a distinct silhouette, or the variant renders NMSR's
   * default view — the dashboard flags it as a fallback — and CTR grouped by pose compares a
   * variable that never varied.
   */
  thumbnailVariants: Array<{ left: string; right: string }>;
  /** Minimum cross-correlation confidence (sync.ts) to trust the refined audio sync offset. */
  syncConfidenceThreshold: number;
  /** VOD trim window: seconds of buffer before the estimated match start. */
  preRollSec: number;
  /**
   * How far each POV's audio sits toward its own side of the frame in the fast export: 0.5 is
   * both in the centre (the mix before 18 Sept 2026), 1 is hard left/right, 0.7 keeps both
   * voices in both ears with each clearly where its stream is. A viewer asked for it; a hard pan
   * is tiring on headphones and phone speakers are mono anyway. The Short is stacked top/bottom
   * and stays centred.
   */
  povAudioPan: number;
  /**
   * Seconds kept after the finish, at most (the tail is cut earlier where the winner goes quiet
   * and still, never under 15 s). 30, not 60: measured on the same match the competitor posted,
   * their video ends ~10 s after the finish and ours ran 59 s into the winner's stats screen; the
   * subscribe card lands at +3 s and the rank-up screen is over by +15. Also the VOD download's
   * buffer after the run.
   */
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
   * per-video thumbnail impressions and CTR (see src/youtube/youtube.ts).
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
   * The competitor whose uploads the suggestion cards are checked against (src/dashboard/rivalPosts.ts):
   * MCSR Matches posts the same matches this channel picks, a day later, to 37x the
   * subscribers. A matchup it has already covered is flagged on the card and ordered after the
   * fresh ones. Empty string turns the check off; it also needs the YouTube token.
   */
  rivalChannelHandle: string;
  /**
   * A tip-jar URL (Ko-fi, PayPal.me) for the description's "Tip jar" line. The
   * audit named it the one revenue stream not gated at 41 subscribers, and the active
   * competitor runs a PayPal.me link in every description. Empty: no line.
   */
  supportUrl: string;
  /**
   * Where the PC that publishes pulls finished files *from*, as an rsync/ssh target — e.g.
   * `homelab@actimel:/home/homelab/mcsr-media`, which is this container's `/media` seen from
   * the lab host (compose bind mount), not the container path. A pull target, not a push (see
   * src/dashboard/publishSet.ts). Empty string hides the publish kit's pull block; nothing here is ever
   * executed by the server.
   */
  pullSource: string;
  /** Where those files land on the PC. `~` is expanded by the operator's own shell. */
  pullDest: string;
  /**
   * Seconds of overlay before the RTA timer starts.
   *
   * This is also where the published video begins: the timeline is anchored on the world-load
   * countdown (kdenliveProject.ANCHOR_SEC), so an overlay lead-in equal to that anchor puts the
   * overlay, the intro and the footage all at timeline 0 with nothing trimmed. Changing it
   * away from 10 makes the overlay clips get head-trimmed to keep match start in place, which
   * is correct but wastes render, and an intro shorter than the difference is rejected outright.
   *
   * The VOD clips keep a much larger `preRollSec` because the audio-sync search needs room to
   * hunt for the countdown; that headroom is trimmed off the timeline rather than shown.
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
   * rather than "render this?" with a chart. See src/dashboard/nightly.ts for what it will and won't do.
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
   * How many matches one night may render, at most. 1 keeps the scheduler as timid as it was;
   * raising it lets a clean run start the next eligible card while the lab is still idle, but
   * only within four hours of `nightlyRenderHourUtc` and only through the same guards that
   * decide the first render — disk, a render in flight, nothing eligible (see src/dashboard/nightly.ts).
   * Each match is 2–2.5 GB, so this is bounded by disk long before it is bounded by hours.
   */
  nightlyMaxRenders: number;
  /**
   * Where to POST a one-line plain-text result when a nightly render settles — an ntfy.sh topic
   * URL takes exactly that body, which is why the body is plain text and nothing else. Empty
   * string turns the notification off; a failed POST is logged, never fatal.
   */
  nightlyNotifyUrl: string;
  /**
   * Whether the dashboard may call `videos.insert` at all. Off, POST /api/youtube/upload answers
   * 403 and every upload goes through Studio. The default stayed false while the YouTube API
   * compliance audit was pending (cleared 15 Sept 2026); the lab's config sets it true.
   */
  youtubeUploadEnabled: boolean;
  /**
   * Whether a Studio upload the channel scan pairs to a match for the first time is finished by
   * the dashboard on the spot — thumbnail, playlists, first comment — rather than waiting for
   * the "Finish on YouTube" button. Off by default: those calls are visible on the live channel,
   * and the button exists so the operator sees what a finish does before letting it run alone.
   */
  youtubeAutoFinish: boolean;
  /**
   * What the nightly does with the MP4 it just exported: nothing, upload it private, or upload
   * it scheduled for the next publish slot (`publishHourUtc`; the Short follows 18 h later).
   * Needs `youtubeUploadEnabled` too. "off" by default so no config default changes what a
   * nightly render does tonight.
   */
  nightlyUpload: "off" | "private" | "scheduled";
  /**
   * The hour (UTC, 0-23) the publish kit proposes for "Publish at", and the upload form's
   * default. 19 is the active competitor's measured slot — 36 of its last 50 uploads on the
   * dot, median 4.2k views there against 1.6k for its earlier 17:xx uploads — and 21:00 in
   * Poland, 15:00 on the US east coast. See src/youtube/publishSlot.ts.
   */
  publishHourUtc: number;
  /**
   * The publish hour for a playoff series video (a match directory holding `series.json`,
   * src/playoffs/series.ts), its own slot so a series and that day's ranked match do not compete
   * for the same hour or push each other a day out. 23:00 UTC is 19:00 ET, a lean-back hour for
   * a 40-minute video on a channel a quarter of whose views are American (the 22 Sept 2026 audit).
   */
  seriesPublishHourUtc: number;
  /**
   * Whether the bottom band's meta column turns into a subscribe card a few seconds after the
   * finish, for the post-roll. Subscribers are the binding Partner Programme gate (500; the
   * hours gate levels off under 4,000 at any cadence this channel can run), and the post-roll
   * is where 35-69% of viewers are still watching with nothing on screen changing. Off keeps
   * the achievements block through the tail.
   */
  postRollCta: boolean;
  /**
   * A subscribe line in the meta column during the race, this many seconds after match start,
   * for `midRollCtaSec` seconds; null shows none. The 22 Sept 2026 audit measured the post-roll
   * card reaching 25–45% of viewers and the first split comparison (~90 s) 50–60%; the operator
   * switched it on by default that morning, and the Round of 16 series were re-rendered with it.
   */
  midRollCtaAtSec: number | null;
  midRollCtaSec: number;
  /**
   * A "COMING UP · 5:22 / THE LEAD CHANGES AT THE FORTRESS" card in the meta column this many
   * seconds after match start, for `teaserSec` seconds; null shows none. Every long-form loses
   * 16–22 points of retention between 3% and 10% of the video (22 Sept 2026); at 10 s the card
   * lands at 3% of a ten-minute match's video, 13 s after the intro card clears. The moment is
   * chosen from the timeline (src/pipeline/teaser.ts); a match with none shows nothing.
   */
  teaserAtSec: number | null;
  teaserSec: number;
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
  /**
   * Whether detected playoff games (src/playoffs/playoffs.ts) go ahead of the ordinary suggestions in
   * the nightly's pick order. Off by default, and deliberately so: a default that changes what
   * tonight's nightly renders is a house-rule violation. The operator flips it to true when a
   * tournament starts and back to false when the bracket is done.
   */
  playoffsFirst: boolean;
  /**
   * Nicknames the *title* spells differently: the broadcast and the reaction channels call
   * Pinne "Skycrab" and lowk3y_ "lowkey" (their Twitch names), and that is what a viewer of the
   * playoffs types. The operator's call, 22 Sept 2026 — the title only; the overlay, the
   * description and the tags keep the API spelling (the tags carry both).
   */
  titleNames: Record<string, string>;
  /**
   * How a playoff game's thumbnails are framed (remotion/Thumbnail.tsx `playoff`): "plain" is the
   * ranked look (a category band, the rating in the nameplate); "bracket" puts the round in the
   * band, the seed in the nameplate and the series length under the VS; "trophy" grows the band
   * for a gold PLAYOFFS wordmark and frames the body. The operator's pick, 22 Sept 2026 — the
   * renders of both are in the night's report. A ranked match is never framed.
   */
  playoffThumbnailStyle: "plain" | "bracket" | "trophy";
  /**
   * An LLM CLI to ask reasoning questions (src/shorts/reasoner.ts), as an argv array. Whole
   * arguments (not `--prompt={prompt}`) are placeholders: `{prompt}` is the prompt — when no
   * argument is, it goes on stdin — `{schema}` a JSON Schema the answer is held to and `{dir}` the
   * directories the CLI may read (the flag before it is repeated per directory); a caller with no
   * schema or directory drops that argument and the flag before it, so one argv serves every
   * caller. Null (the default) turns every question into its heuristic fallback. The callers: the
   * Short's moment picker, which has the model watch the finished video (src/shorts/videoPick.ts,
   * `npm run pick`), and the older re-ranking of the scored windows (src/shorts/shortReason.ts).
   * The lab's (LAB_REASONER_COMMAND, the example file's value): Antigravity's CLI, signed in on the
   * operator's subscription under its own HOME, Gemini 3.8 Flash at high effort (the operator's
   * choice, 23 Sept 2026: a whole 8:52 match in 93–136 s), and never with
   * --dangerously-skip-permissions — the prompt carries Twitch chat, and `--sandbox` keeps the
   * model to reading files.
   */
  reasonerCommand: string[] | null;
  /**
   * The /watch skill's `watch.py` (the claude-watch plugin), which the Short's picker runs on each
   * player's own POV clip for full-resolution stills of the match (src/shorts/watchPov.ts), and
   * a transcript of the stream when GROQ_API_KEY or OPENAI_API_KEY is set. Run as `python3
   * <watchScript>`. Missing on disk, it is skipped with one log line and the pick goes on without
   * it; null turns it off.
   */
  watchScript: string | null;
}

/** The lab's `reasonerCommand`: see its comment in `Config`. */
export const LAB_REASONER_COMMAND: readonly string[] = [
  "env",
  "HOME=/app/.tools/agy-home",
  "/app/.tools/bin/agy",
  "-p",
  "{prompt}",
  "--model",
  "gemini-3.8-flash-high",
  "--output-format",
  "json",
  "--json-schema",
  "{schema}",
  "--add-dir",
  "{dir}",
  "--sandbox",
  "--print-timeout",
  "1400s",
];

/** Every key at its default; `mcsr-vid.config.example.json` is this object, written by `npm run config:example`. */
export const DEFAULTS: Config = {
  leftPose: "walking",
  rightPose: "crossed",
  thumbnailVariants: [
    // First is the existing look, so nothing changes for a match already published.
    { left: "walking", right: "crossed" },
    { left: "default", right: "default" },
    { left: "cheering", right: "relaxing" },
    { left: "marching", right: "crouching" },
  ],
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  povAudioPan: 0.7,
  postRollSec: 30,
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
  seriesPublishHourUtc: 23,
  postRollCta: true,
  midRollCtaAtSec: 90,
  midRollCtaSec: 4,
  teaserAtSec: 10,
  teaserSec: 5,
  nightlyRenderExport: true,
  nightlyMaxRenders: 1,
  nightlyNotifyUrl: "",
  youtubeUploadEnabled: false,
  youtubeAutoFinish: false,
  nightlyUpload: "off",
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
  playoffsFirst: false,
  titleNames: { Pinne: "Skycrab", lowk3y_: "lowkey" },
  playoffThumbnailStyle: "plain",
  reasonerCommand: null,
  watchScript: path.join(os.homedir(), ".claude/plugins/cache/claude-watch/watch/0.2.0/scripts/watch.py"),
};

/** The overrides file. Exported so the settings panel writes the same one the loader reads. */
export const CONFIG_PATH = path.resolve("mcsr-vid.config.json");

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
    if (key === "midRollCtaAtSec" || key === "midRollCtaSec" || key === "teaserAtSec" || key === "teaserSec") {
      const nullable = key === "midRollCtaAtSec" || key === "teaserAtSec";
      if (!((nullable && value === null) || (typeof value === "number" && value >= 0 && value <= 3600))) {
        throw new Error(
          `${CONFIG_PATH}: "${key}" must be seconds from 0 to 3600${nullable ? ", or null" : ""}.`,
        );
      }
      continue;
    }
    if (key === "titleNames") {
      const ok =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every(
          (v) => typeof v === "string" && v.trim() !== "",
        );
      if (!ok)
        throw new Error(`${CONFIG_PATH}: "titleNames" must map nicknames to the names the title shows.`);
      continue;
    }
    if (key === "playoffThumbnailStyle") {
      if (value !== "plain" && value !== "bracket" && value !== "trophy") {
        throw new Error(`${CONFIG_PATH}: "playoffThumbnailStyle" must be "plain", "bracket" or "trophy".`);
      }
      continue;
    }
    if (key === "povAudioPan") {
      if (typeof value !== "number" || !(value >= 0.5 && value <= 1)) {
        throw new Error(
          `${CONFIG_PATH}: "povAudioPan" must be a number from 0.5 (centred) to 1 (hard left/right).`,
        );
      }
      continue;
    }
    // Two pose names per entry and nothing else. The per-pair `hook` flag was dropped when every
    // pair started rendering a hooked twin; a config still carrying it would be quietly ignored.
    if (key === "thumbnailVariants") {
      const pairs = Array.isArray(value) ? value : null;
      const bad =
        pairs === null ||
        pairs.length === 0 ||
        !pairs.every(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            Object.keys(p).every((k) => k === "left" || k === "right") &&
            typeof p.left === "string" &&
            typeof p.right === "string",
        );
      if (bad) {
        throw new Error(
          `${CONFIG_PATH}: "thumbnailVariants" must be a non-empty array of { left, right } pose names.`,
        );
      }
      continue;
    }
    if (key === "reasonerCommand") {
      if (value !== null && !(Array.isArray(value) && value.every((s) => typeof s === "string"))) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be an array of strings or null.`);
      }
      continue;
    }
    if (key === "watchScript") {
      if (value !== null && (typeof value !== "string" || value.trim() === "")) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be the path to watch.py, or null.`);
      }
      continue;
    }
    // Three words, not any string: a typo here ("scheduled " with a space) would silently be
    // "off" at the one switch that decides whether a nightly upload happens.
    if (key === "nightlyUpload") {
      if (value !== "off" && value !== "private" && value !== "scheduled") {
        throw new Error(`${CONFIG_PATH}: "nightlyUpload" must be "off", "private" or "scheduled".`);
      }
      continue;
    }
    // Whole renders, at least one. 0 would turn the nightly off through a key that does not say
    // so — `"nightlyRenderHourUtc": null` is how you do that — and a fraction would read as a
    // limit while behaving like its floor.
    if (key === "nightlyMaxRenders") {
      if (!Number.isInteger(value) || (value as number) < 1) {
        throw new Error(`${CONFIG_PATH}: "nightlyMaxRenders" must be a whole number of renders, 1 or more.`);
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
