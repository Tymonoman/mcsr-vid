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
  /**
   * Off (default): the auto-picked thumbnail is always the first `thumbnailVariants` entry
   * (`walking-crossed`), byte for byte what every match has shipped with. On: a fresh render
   * with no operator pick yet chooses deterministically by match id among the pose pairs
   * actually rendered, so the auto default stops being the same pose 88% of the time (7 Oct
   * 2026 packaging audit). Only decides the *first* choice — an operator's pick, and a video
   * already uploaded, are never touched either way (`renderThumbnailVariants` carries an
   * earlier choice forward regardless of this key).
   */
  thumbnailRotatePoses: boolean;
  /**
   * Minimum sync.ts confidence to trust the countdown placement without review: both clips read
   * scores 0.68 or more, one clip read 0.1 (the other sits on its coarse estimate), none 0.
   * Below it the Kdenlive marker says LOW and the dashboard asks for the sync editor.
   */
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
   * `export:fast`'s final pass upscales the already-composited 1080p frame to 2560x1440
   * (lanczos, same fps) before encoding — every overlay asset (`remotion/layout.ts`, the stills,
   * the intro card) stays 1080p; only the last filter in the graph changes. Uploading a 1920x1080
   * video's worth of detail at a higher pixel count is widely reported to land it in YouTube's
   * higher-bitrate transcode tier at every resolution a viewer picks — unconfirmed for this
   * channel, which is what this flag is for testing (picture-quality.md, the night-1006 report).
   * Off by default: it changes what a render uploads, the operator's call. A playoff series
   * needs every game joined by `-c copy` at the same resolution — `assembleSeries` refuses to
   * join a series whose games were exported with this flag on for some and off for others.
   */
  exportUpscale1440: boolean;
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
   * The channel's `@handle`, without the "@" — a watch page's comment author link is `/@handle`,
   * not `/channel/<id>`, so the Studio worker's pin finds our own comment by this.
   */
  youtubeChannelHandle: string;
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
   * The competitors whose uploads the suggestion cards and the match list are checked against
   * (src/dashboard/rivalPosts.ts): MCSR Matches posts the same matches this channel picks, a day
   * later, to many times the subscribers; MCSR Vault posts a 1v1 of the same players about weekly.
   * A card says whether each posted this match (ordered after the fresh ones) or only this pair in
   * another match (information only). MCSR Replays (@mcsrreplay) is left out: dormant since
   * 18 Apr 2026. An empty list turns the check off; a single string (an older config file) is a
   * list of one. Read from the public upload feeds, never with the YouTube token (the audit: own
   * channel, own data).
   */
  rivalChannelHandle: string[];
  /**
   * Players whose matches the suggestion list and the nightly rank first (30 Sept 2026 plan:
   * recognisable names are what converts subscribers). API spellings, compared whole and ignoring
   * case — Pinne is Skycrab, lowk3y_ is lowkey. A match with one of them ranks above every match with
   * none, both when a scan chooses the slots (`take`, src/dashboard/suggest.ts, so its match reaches
   * the list — at the next scan) and when the cards are ordered, close and chaos together, the bucket
   * only a tiebreaker (`presentSuggestions`, read fresh, so a change re-orders at once). Inside that
   * tier a match counts half again for one of them and twice for two. The cached `score` stays the
   * bucket's own. Empty = no tier and no bonus; the default list changes which card the nightly takes
   * first. A player need not be on this list to rank above a no-name match — see
   * `knownFollowerThreshold`, the other half of that tier.
   */
  favouritePlayers: string[];
  /**
   * Whole days, 0-30 (0 is off): a match whose two players this channel already put out a
   * long-form video for — public, scheduled, or rendered and waiting for its hooks — within this many
   * days of now counts for half when the suggestion list is ordered (`presentSuggestions`,
   * src/dashboard/pairPosts.ts). A demotion,
   * not a skip: a marquee rematch still renders when nothing else qualifies. Feinberg vs Infume
   * went up on 24, 27 and 29 Sept 2026, and a pair that brings a new runner's audience converts
   * better than a repeat (30 Sept 2026 plan). The default changes which card the nightly takes first.
   */
  pairRepeatDays: number;
  /**
   * The Twitch follower count that makes a player off `favouritePlayers`, with no measured draw,
   * "known" rather than a no-name: a match needs only *one* known player to rank above every match
   * with none — below every match with a favourite — in the suggestion list and the nightly's pick
   * alike (`tierFor`, src/dashboard/suggest.ts), and the nightly renders no match without one unless
   * it was queued. 10,000: every sampled player under ~10k followers drew at or below the channel's
   * median (draw.json, 1 Oct 2026), and on supply.json's 7 days the gate still left 100 matches,
   * 8–23 a day — 1,000 let ninananina (6.6k), CxrtxR (4.5k) and grq_ (4.3k) fill the list (the
   * operator, 1 Oct 2026: "the suggestion system is shit it recommends and schedules matches that no
   * one will watch").
   */
  knownFollowerThreshold: number;
  /**
   * Re-seed `DEFAULT_DRAW`/`UNMEASURED_DRAW` from the channel's own numbers instead of the
   * constant measured once on 1 Oct 2026 (11 Oct 2026, `src/dashboard/drawLearn.ts`): a player
   * with 3+ measured long-form videos gets a learned draw (the median of each video's first-7-day
   * views ÷ the channel median), and a pair whose most recent measured meeting beat that median
   * skips the `pairRepeatDays` halving. Off (default): `audienceFor` falls back to
   * `DEFAULT_DRAW`/`UNMEASURED_DRAW` exactly as before this existed — byte-for-byte today's
   * ordering, pinned by a test. On, the 15-minute tick (`src/dashboard/server.ts`) recomputes
   * `<mediaDir>/.draw-learned.json` at most once a day; a fresh pool that has not computed yet
   * (or a corrupt file) is the same as off until it has.
   */
  learnedDraw: boolean;
  /**
   * A candidate whose finish (`MatchMetrics.resultMs`) is at or under this many seconds gets its
   * audience multiplied by `RECORD_PACE_BOOST` (`src/dashboard/suggest.ts`), so a near-record race
   * ranks up inside its tier — it never names or implies who won, only reorders. Null (default):
   * today's ordering exactly. 11 Oct 2026.
   */
  recordPaceBoostSec: number | null;
  /**
   * A tip-jar URL (Ko-fi, PayPal.me) for the description's "Tip jar" line. The
   * audit named it the one revenue stream not gated at 41 subscribers, and the active
   * competitor runs a PayPal.me link in every description. Empty: no line.
   */
  supportUrl: string;
  /**
   * Rotates the pinned comment's sync sentence and the description's closer/subscribe lines
   * through 3-4 stock phrasings of the same facts, each picked by its own match-id-derived index
   * so the three don't move in lockstep, and stable per match so a re-render or re-upload keeps
   * its phrasing (`closerFor`/`subscribeLineFor`, src/pipeline/description.ts;
   * `SYNC_SENTENCE_VARIANTS`, src/youtube/youtubeStore.ts). Off by default: the 6 Oct 2026
   * packaging audit found the description's closer byte-identical in 93% of descriptions for
   * 7 weeks (`packaging.md` #4), and the pinned comment's sync sentence byte-identical in 29 of
   * 76 channel replies over the same stretch (`packaging.md` #1) — confirmable by any viewer who
   * opens two videos; on breaks that, changing no fact or link. Off is byte for byte today's
   * wording.
   */
  copyVariety: boolean;
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
   * The 15-minute tick's Telegram alarm: under this many GB free on `/media`, "Needs you" gets a
   * line naming the free space and about how much the next NAS sweep (`freeLocalCopies`,
   * src/dashboard/nightly.ts) would recover right now. Never blocks anything by itself — see
   * `MIN_FREE_MATCHES` for the nightly's own pick-time guard and the 15 GB "still try" line
   * `runOnce` logs before starting a render.
   */
  spaceAlarmGb: number;
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
   * Whether the first comment on a scheduled video is posted soon after it actually goes public
   * instead of waiting for the nightly's once-a-night tick hours later. On, the 15-minute tick
   * (src/dashboard/server.ts, the one that already drives `shortTick`) posts it within a jittered
   * 5-20 minutes of `publishAt` — the same `finishOnYouTube` comment step, the same once-only
   * guards (a thread already there, a still-private video) as `retryPendingComments`. Off by
   * default: the comment keeps landing on the nightly's tick, which is the visible 03:00:0X
   * pattern the 6 Oct 2026 packaging read named as one of the channel's "machine-made" tells.
   */
  commentSoonAfterPublish: boolean;
  /**
   * Whether a real, headed Chrome (src/youtube/studioBrowser.ts) is ever launched to do what
   * Studio has no API for — phase 1 is pinning the channel's own first comment
   * (src/youtube/studioActions.ts). Off by default, like `nightlyUpload`: it is a deliberate edit
   * on the box, since turning it on starts a browser signed into the channel owner's own Google
   * account. See CLAUDE.md's "Studio automation" section.
   */
  studioAutomation: boolean;
  /**
   * The operator, 18 Oct 2026: "we will run new ones once everything is built". On, the Studio
   * worker plans and starts no new Test & Compare; running ones are still read daily. Config file
   * only, read fresh each worker cycle (`abTestsPausedNow`).
   */
  abTestsPaused: boolean;
  /** Same-rivalry end screens (see `endScreenRivalryNow`); off until a live Studio check. */
  endScreenRivalry: boolean;
  /**
   * A "WHO TAKES IT?" community poll on every long-form that went public in the last 36 h
   * (`src/youtube/studioCommunity.ts`, the Studio worker). Config file only, like
   * `studioAutomation`: off until a supervised `npm run studio -- poll <id>` has confirmed the
   * composer's selectors live. Read fresh each worker cycle (`communityPollsNow`).
   */
  communityPolls: boolean;
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
   * UTC calendar days a ranked video and a series of the same two players are kept apart when
   * the publish slot is chosen (src/youtube/publishSlot.ts `pairGapTimes`). 0 turns it off. The
   * doogile–Aquacorde series drew 84 views in 32 h beside their ranked video's 2,095 the same day.
   */
  seriesPairGapDays: number;
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
   * The line above SUBSCRIBE on both subscribe cards, the mid-race line and the post-roll: why to
   * subscribe (plan item 4, 29 Sept 2026 — a bare "SUBSCRIBE" gave the viewer no reason). One row
   * of the meta column, at most `CTA_REASON_MAX_CHARS` characters, because the post-roll card sits
   * under the final time and has room for no second row. It takes the place of "FOR THE NEXT ONE";
   * empty shows today's bare card.
   */
  ctaReason: string;
  /**
   * A "COMING UP · 5:22 / THE LEAD CHANGES AT THE FORTRESS" card in the meta column this many
   * seconds after match start, for `teaserSec` seconds; null shows none. Every long-form loses
   * 16–22 points of retention between 3% and 10% of the video (22 Sept 2026); at 10 s the card
   * lands at 3% of a ten-minute match's video, 13 s after a 7 s intro card clears. The moment is
   * chosen from the timeline (src/pipeline/teaser.ts); a match with none shows nothing.
   */
  teaserAtSec: number | null;
  teaserSec: number;
  /**
   * Seconds the intro card covers the frozen countdown, 2-7. It never moves the timeline's anchor
   * (match start at 10 s there, and in the Kdenlive project); `export:fast` cuts `7 - introSec`
   * off the countdown's head (`headTrimSec`), so the MP4's match start is at introSec + 3 s. The 24 Sept 2026 audit measured 22.5 points (median) lost in the first 3% of the
   * video and proposed at most 3 s; the default keeps the 7 s card until the operator decides.
   */
  introSec: number;
  /**
   * The COMING UP line (src/pipeline/teaser.ts) large across the bottom of both POVs from the
   * intro card's end to match start (`overlay-countdown-teaser.png`, export:fast only). Off by
   * default: on changes what the nightly renders.
   */
  countdownTeaser: boolean;
  /**
   * "Explain the moves": the first time either player reaches a split, the meta column says what
   * the split is for ("BASTION / TRADING GOLD TO PIGLINS FOR ENDER PEARLS") for this many seconds;
   * null shows none (src/pipeline/explainMoves.ts). Written for the Minecraft player who has never
   * followed speedrunning, and the YPP reused-content answer ("where you explain the moves"). Off
   * by default: it changes what the nightly renders, so switching it on is the operator's call.
   */
  explainMovesSec: number | null;
  /**
   * The retention opening (proposal approved 19 Oct 2026, experiment x5-retention-opening), every
   * switch default off so a render is today's until an experiment arm turns them on:
   *
   * `coldOpenSec`: seconds of the race's closest mid-race split (src/pipeline/coldOpen.ts) put in
   * front of the export, in the normal layout with the saved title hook big at the top. Planned at
   * export, joined when the hooks are saved (before the long-form uploads). Null is none.
   */
  coldOpenSec: number | null;
  /** The versus card's PB/avg/games/win-rate block; false draws names, heads and VS only. */
  introStats: boolean;
  /** "SAME SEED. SAME WORLD. / FIRST TO KILL THE DRAGON WINS" over the intro card and countdown. */
  stakesLine: boolean;
  /**
   * Where "explain the moves" and the COMING UP line are drawn: "panel" in the meta column (today),
   * "banner" big over the POVs (COMING UP over the empty splits column), with the seed type's
   * opener and the lava-bucket beat added (src/pipeline/banners.ts). export:fast only.
   */
  explainMovesStyle: "panel" | "banner";
  /** "<SPLIT>: N.Ns APART" over the POVs at each split's second arrival; never who leads. */
  gapChips: boolean;
  /**
   * The operator's own grant, 8 Oct 2026 ("a match whose hooks I haven't saved 6 h after its pick
   * lands gets the best title hook that passes hookProblem + hookLabelProblem + spoilsTheResult
   * (the model's, else a hooks.ts chip) and a Short hook chosen the same way; the chain then runs
   * as if I'd pressed Save"): `autoHooksTick` (src/dashboard/shortFlow.ts) saves a match's hooks
   * by itself once its pick is this many hours old. Null (default) is off; the operator turns it
   * on live in Settings, since it is what starts uploading a video nobody has looked at.
   */
  autoHooksAfterHours: number | null;
  /**
   * The operator's own call, 11 Oct 2026 ("you're gonna make the shorts from now on"): the
   * session cuts every match's Short by hand (`npm run short:hand`, src/shorts/handShort.ts)
   * instead of the pipeline's own pick-and-render. On, the chain never picks or renders the Short
   * itself (the pick after export still runs, `ensurePick` — auto-hooks needs its title hooks, and
   * its window is only a hint); the long-form uploads at its slot without waiting on the Short,
   * and the Short uploads once `short-<id>.hand.json` and its mp4 exist. Off (default) is today's pick → render → upload-video → upload-short chain, unchanged.
   */
  shortsByHand: boolean;
  /**
   * Suggestion slots per bucket. Close races and entertaining messes are ranked
   * separately so a run of very tight matches can't crowd the funny ones off the list.
   */
  suggestCloseSlots: number;
  suggestChaosSlots: number;
  /**
   * Slots, on top of the close and chaos ones, for a known player's match (`tierFor`: a favourite
   * or a measured/followed draw) that needs no closeness or chaos score at all. The operator,
   * 4 Oct 2026: "schedule some matches really known players the matches don't have to be that
   * interesting you can lower the threshold like this for the suggestion mechanism." A match
   * already claimed by the close or chaos bucket does not also take one of these.
   */
  suggestKnownSlots: number;
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
   * The operator's own nickname for a runner (API nickname -> the operator's own name for them,
   * matched case-insensitively), the operator's own call, 18 Oct 2026: a title-hook option is
   * "NICK_LEFT vs NICK_RIGHT" once both of a match's players have an entry here; code never
   * invents one, and never a label from a word list. `titleOptions.ts`'s only source of a runner
   * name in a title hook. Default empty: nothing until the operator fills it in.
   */
  runnerNicknames: Record<string, string>;
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
  /**
   * Hour of day (Warsaw local, `Europe/Warsaw`, DST-correct) the Telegram bot sends its one daily
   * morning report — see `src/telegram/`. Null turns the daily report off; slash commands still
   * answer. Needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `/app/.env` regardless.
   */
  telegramReportHourWarsaw: number | null;
  /**
   * The dashboard's own address, for the links the Telegram bot puts in its reports — the lab's,
   * plain http (see CLAUDE.md's Clipboard API pitfall for why it is not https). No trailing slash.
   */
  dashboardBaseUrl: string;
  /**
   * Nicknames permanently off limits, API spelling, compared whole and ignoring case
   * (`isBlockedPlayer`/`blockedIn`, below). The operator, 2 Oct 2026, after Aquacorde commented
   * that he does not give permission for his footage to be used in the videos: "were fuuuuucked
   * … take down all his videos and blacklist him." BeefSalad joined 4 Oct 2026 after commenting
   * "do not use my footage again" — the operator's standing rule is that a runner's no is a
   * block, same as Aquacorde's. A match with a blocked player is dropped before it is scored
   * (suggestions), never offered to the nightly even when queued, never listed as "worth
   * rendering", never uploaded (long-form or Short), and never rendered. Empty means nobody is
   * blocked.
   */
  blockedPlayers: string[];
  /**
   * MCSR Ranked nicknames of outside creators whose ranked matches are worth racing to render
   * (the YPP growth plan's "creator watch" idea, 11 Oct 2026: every subscriber burst at the rival
   * replay channels followed an outside creator's MCSR moment — Ludwig's arc, Dec 2025-Feb 2026 —
   * and this channel's Suggested traffic gets 0% from a bigger channel). Read by the 15-minute
   * tick (`src/dashboard/creatorWatch.ts`) when `creatorWatch` is on. Empty by default: a verified
   * name (CLAUDE.md's Dashboard section names who actually had ranked-match activity, checked live
   * 11 Oct 2026) is the operator's own addition, not a guess baked into the default.
   */
  creatorWatchlist: string[];
  /**
   * Off by default. On: the tick above reads each watched nickname's few most recent ranked
   * matches; a new one with no blocked player and both players' Twitch VODs found goes to the
   * front of tonight's nightly queue (at most one such match a night) — the block list still wins
   * over it, the same as it wins over every other queue entry.
   */
  creatorWatch: boolean;
  /**
   * Off by default, and a deliberate edit on the box like `nightlyUpload` (not in Settings): it
   * posts in public on another platform. On, with the four X keys in /app/.env, the 15-minute tick
   * posts the newest public long-form's hand-cut Short to X, at most one a day (src/x/xPost.ts).
   */
  xAutoPost: boolean;
  /**
   * Off by default, a config-file edit like `xAutoPost`. On, the 15-minute tick sends one silent
   * Telegram line per comment-count threshold (1, 5, 10, 25) a long-form crosses in its first 48h
   * public — counts and a Studio link only, never a comment's text or author
   * (src/telegram/commentNudge.ts).
   */
  commentNudges: boolean;
  /**
   * Off by default, config-file only like `xAutoPost`. On, the Studio worker's cycle
   * (`src/youtube/studioWorker.ts`) posts the same one-a-day clip through a real, signed-in
   * browser instead of the paid API (`src/x/xBrowser.ts`): the X profile lives in
   * `X_PROFILE_DIR` (default `/app/.x-profile`), signed in once by hand over `npm run x -- login`.
   */
  xBrowserPost: boolean;
}

/**
 * The longest `ctaReason` one row of the subscribe card holds: its text is 276 px wide and 16 px
 * Monocraft at 0.04em spacing runs 11.3 px a character (remotion/overlay.source.css, `.cta-why`).
 */
export const CTA_REASON_MAX_CHARS = 24;

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
  thumbnailRotatePoses: false,
  syncConfidenceThreshold: 0.15,
  preRollSec: 150,
  povAudioPan: 0.7,
  exportUpscale1440: false,
  postRollSec: 30,
  defaultRunSec: 900,
  mediaDir: "media",
  youtubeChannelId: "UCm2mAyONTHlmIxZzNmi388w",
  youtubeChannelHandle: "MCSRReplayoffs",
  youtubeReportingJobId: "eda017ae-a539-4c79-8e2c-66d1af74264a",
  youtubePlaylistTitle: "MCSR Ranked matches",
  youtubePlaylistUrl: "",
  rivalChannelHandle: ["mcsrmatches", "mcsr-vault"],
  favouritePlayers: ["doogile", "Feinberg", "Infume", "Pinne", "lowk3y_", "silverrruns", "edcr"],
  pairRepeatDays: 3,
  knownFollowerThreshold: 10_000,
  learnedDraw: false,
  recordPaceBoostSec: null,
  supportUrl: "",
  copyVariety: false,
  pullSource: "",
  pullDest: "~/Replayoffs",
  overlayLeadInSec: 10,
  overlayFps: 30,
  renderConcurrency: null,
  nightlyRenderHourUtc: 3,
  spaceAlarmGb: 25,
  publishHourUtc: 19,
  seriesPublishHourUtc: 23,
  seriesPairGapDays: 3,
  postRollCta: true,
  midRollCtaAtSec: 90,
  midRollCtaSec: 4,
  ctaReason: "A NEW MATCH EVERY DAY",
  teaserAtSec: 10,
  teaserSec: 5,
  introSec: 7,
  countdownTeaser: false,
  explainMovesSec: null,
  coldOpenSec: null,
  introStats: true,
  stakesLine: false,
  explainMovesStyle: "panel",
  gapChips: false,
  autoHooksAfterHours: null,
  shortsByHand: false,
  nightlyRenderExport: true,
  nightlyMaxRenders: 1,
  nightlyNotifyUrl: "",
  youtubeUploadEnabled: false,
  youtubeAutoFinish: false,
  commentSoonAfterPublish: false,
  studioAutomation: false,
  abTestsPaused: false,
  endScreenRivalry: false,
  communityPolls: false,
  nightlyUpload: "off",
  suggestCloseSlots: 8,
  suggestChaosSlots: 2,
  suggestKnownSlots: 4,
  suggestCacheTtlMin: 30,
  suggestMaxScanRequests: 40,
  // Only ~10% of dual-VOD matches have a comparable finish (usually the loser stops once the
  // winner is done), so filling eight close slots needs a shortlist well past eight.
  suggestDetailFetchLimit: 120,
  suggestFastRunTargetSec: 420,
  suggestSlowRunCutoffSec: 600,
  suggestFollowerWeight: 3,
  suggestWeights: DEFAULT_WEIGHTS,
  // The operator, 18 Oct 2026: "pull them first I'll notify you when theres an event upcoming" —
  // on by default now; it still only ever does anything while a bracket has undetected games.
  playoffsFirst: true,
  titleNames: { Pinne: "Skycrab", lowk3y_: "lowkey" },
  runnerNicknames: {},
  playoffThumbnailStyle: "plain",
  reasonerCommand: null,
  watchScript: path.join(os.homedir(), ".claude/plugins/cache/claude-watch/watch/0.2.0/scripts/watch.py"),
  telegramReportHourWarsaw: 7,
  dashboardBaseUrl: "http://actimel:8080",
  // The operator, 2 Oct 2026: "were fuuuuucked. aquacorde just commented he doesn't give
  // permission for his footage to be used in the vids. take down all his videos and blacklist
  // him." His 7 videos and 4 playlists were set private on the channel the same day. BeefSalad
  // joined 4 Oct 2026 after commenting "do not use my footage again" on the channel.
  blockedPlayers: ["Aquacorde", "BeefSalad"],
  creatorWatchlist: [],
  creatorWatch: false,
  xAutoPost: false,
  commentNudges: false,
  xBrowserPost: false,
};

/** The overrides file. Exported so the settings panel writes the same one the loader reads. */
/** `MCSR_CONFIG` points elsewhere: `npm run test:unit` sets it to a missing file, so the unit tests run on
 *  `DEFAULTS` and never on the operator's live switches (7 Oct 2026: a switch turned on in Settings broke a test). */
export const CONFIG_PATH = path.resolve(process.env.MCSR_CONFIG ?? "mcsr-vid.config.json");

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
    if (
      key === "nightlyRenderHourUtc" ||
      key === "publishHourUtc" ||
      key === "seriesPublishHourUtc" ||
      key === "telegramReportHourWarsaw"
    ) {
      const nullable = key === "nightlyRenderHourUtc" || key === "telegramReportHourWarsaw";
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
    if (
      key === "midRollCtaAtSec" ||
      key === "midRollCtaSec" ||
      key === "teaserAtSec" ||
      key === "teaserSec" ||
      key === "explainMovesSec"
    ) {
      const nullable = key === "midRollCtaAtSec" || key === "teaserAtSec" || key === "explainMovesSec";
      if (!((nullable && value === null) || (typeof value === "number" && value >= 0 && value <= 3600))) {
        throw new Error(
          `${CONFIG_PATH}: "${key}" must be seconds from 0 to 3600${nullable ? ", or null" : ""}.`,
        );
      }
      continue;
    }
    if (key === "autoHooksAfterHours") {
      if (value !== null && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 48)) {
        throw new Error(`${CONFIG_PATH}: "autoHooksAfterHours" must be whole hours 1-48, or null for off.`);
      }
      continue;
    }
    if (key === "introSec") {
      if (typeof value !== "number" || !(value >= 2 && value <= 7)) {
        throw new Error(`${CONFIG_PATH}: "introSec" must be seconds from 2 to 7.`);
      }
      continue;
    }
    // A second row would push the post-roll card's last line out of its plate, so the limit is
    // the card's, not a taste: empty is the bare card.
    if (key === "ctaReason") {
      // Plain ASCII only: any other character falls back to another font and can overflow the row.
      if (
        typeof value !== "string" ||
        value.trim().length > CTA_REASON_MAX_CHARS ||
        /[^\x20-\x7E]/.test(value)
      ) {
        throw new Error(
          `${CONFIG_PATH}: "ctaReason" must be one row of at most ${CTA_REASON_MAX_CHARS} plain ASCII characters, or empty for the bare SUBSCRIBE card.`,
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
    if (key === "runnerNicknames") {
      const ok =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every(
          (v) => typeof v === "string" && v.trim() !== "",
        );
      if (!ok)
        throw new Error(
          `${CONFIG_PATH}: "runnerNicknames" must map API nicknames to the operator's own name for them.`,
        );
      continue;
    }
    // Its default is an array too, so the typeof check below would pass `null`, `{}` and `[1]`; an
    // empty list is fine (no bonus), a blank name is a typo that would never match anyone.
    if (key === "favouritePlayers") {
      if (!Array.isArray(value) || !value.every((n) => typeof n === "string" && n.trim() !== "")) {
        throw new Error(`${CONFIG_PATH}: "favouritePlayers" must be an array of nicknames ([] for none).`);
      }
      continue;
    }
    // A list of handles; a string is an older file's one handle, "" its "none".
    if (key === "rivalChannelHandle") {
      const handles = typeof value === "string" ? [value].filter((h) => h.trim()) : value;
      if (
        !Array.isArray(handles) ||
        !handles.every((h) => typeof h === "string" && /^@?[\w.-]+$/.test(h.trim()))
      ) {
        throw new Error(
          `${CONFIG_PATH}: "rivalChannelHandle" must be a list of YouTube handles ([] for none).`,
        );
      }
      continue;
    }
    if (key === "blockedPlayers" || key === "creatorWatchlist") {
      if (!Array.isArray(value) || !value.every((n) => typeof n === "string" && n.trim() !== "")) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be an array of nicknames ([] for none).`);
      }
      continue;
    }
    if (key === "coldOpenSec") {
      if (value !== null && (typeof value !== "number" || !(value >= 3 && value <= 8))) {
        throw new Error(`${CONFIG_PATH}: "coldOpenSec" must be seconds from 3 to 8, or null for none.`);
      }
      continue;
    }
    if (key === "explainMovesStyle") {
      if (value !== "panel" && value !== "banner") {
        throw new Error(`${CONFIG_PATH}: "explainMovesStyle" must be "panel" or "banner".`);
      }
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
    // A fraction or a negative would silently read as its floor or as "off".
    if (key === "seriesPairGapDays" || key === "pairRepeatDays") {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 30) {
        throw new Error(`${CONFIG_PATH}: "${key}" must be whole days 0-30 (0 is off).`);
      }
      continue;
    }
    // A fraction or a negative would read as a lower bar than the file says.
    if (key === "knownFollowerThreshold") {
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(
          `${CONFIG_PATH}: "knownFollowerThreshold" must be a whole number of followers, 0 or more.`,
        );
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

/** The config file's overrides as parsed JSON, unvalidated; `{}` when there is no file. */
function readOverrides(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function loadConfig(): Config {
  // DEFAULTS is the module's one shared object; handing it out directly would let any mutation
  // of the live config (including a test's) corrupt the default every later reader sees.
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULTS);
  const raw = readOverrides();
  validateOverrides(raw);
  return {
    ...DEFAULTS,
    ...raw,
    // The spread above is shallow, so overriding one weight would drop all the others.
    suggestWeights: {
      ...DEFAULTS.suggestWeights,
      ...((raw.suggestWeights as Partial<ScoreWeights>) ?? {}),
    },
    // An older file names one rival as a string ("" for none); the Settings tab edits a list.
    rivalChannelHandle: [raw.rivalChannelHandle ?? DEFAULTS.rivalChannelHandle].flat().filter(Boolean),
  } as Config;
}

/** Optional `mcsr-vid.config.json` overrides, merged over defaults. Loaded once at import time. */
export const config: Config = loadConfig();

/** Every match's working directory: `<mediaDir>/<id>`. */
export const matchDir = (matchId: number): string => path.join(config.mediaDir, String(matchId));

/**
 * Re-reads `blockedPlayers` from the config file into the live `config`, for a long-running process
 * the Settings tab cannot reach (the Studio worker): a block saved there must reach its next cycle.
 * Only this key — a whole reload would also pick up `studioAutomation`, a deliberate edit on the box.
 * Throws when the file is unreadable or its block list invalid, so the caller fails rather than runs
 * on a stale list. Validates only this key: the worker runs older code than the dashboard until its
 * next blackout, and a key a newer build added must not stop every cycle as "unknown".
 */
export function reloadBlockedPlayers(): void {
  const { blockedPlayers = DEFAULTS.blockedPlayers } = readOverrides();
  validateOverrides({ blockedPlayers });
  config.blockedPlayers = structuredClone(blockedPlayers as string[]);
}

/** `endScreenRivalry` straight from the file (config-file only, default off): the Studio worker's
 *  same-rivalry end screen waits for a live check of Studio's custom end-screen editor. */
export function endScreenRivalryNow(): boolean {
  try {
    return readOverrides().endScreenRivalry === true;
  } catch {
    return false;
  }
}

/** `communityPolls` straight from the file (config-file only, default off), like `endScreenRivalryNow`. */
export function communityPollsNow(): boolean {
  try {
    return readOverrides().communityPolls === true;
  } catch {
    return false;
  }
}

/** `abTestsPaused` straight from the file, for the worker, which cannot see Settings; off if unreadable. */
export function abTestsPausedNow(): boolean {
  try {
    return readOverrides().abTestsPaused === true;
  } catch {
    return false;
  }
}

/**
 * Whether `name` is on `config.blockedPlayers` (`blockedPlayers`, above), whole names, any case.
 * Trimmed both sides: a hand-edited `"BeefSalad "` must still block him.
 */
export function isBlockedPlayer(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return config.blockedPlayers.some((n) => n.trim().toLowerCase() === lower);
}

/** Whether any of `players` is blocked (`isBlockedPlayer`) — the one check every surface shares. */
export function blockedIn(players: readonly string[]): boolean {
  return players.some(isBlockedPlayer);
}
