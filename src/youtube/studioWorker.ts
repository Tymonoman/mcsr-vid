/**
 * `npm run studio -- worker` — a standalone loop (phase 2/3, 8 Oct 2026; CLAUDE.md's "Studio
 * automation" section) that does, on its own, what phase 1 only ever did on the dashboard's
 * nightly tick: add the operator's end-screen template to a long-form that has none, pin a
 * public long-form's own channel comment (phase 5), and run Test & Compare experiments the
 * dashboard's experiment engine has planned.
 *
 * Gated on `opts.enable` (the CLI's own `--enable`, or `STUDIO_WORKER=1`) OR'd with
 * `config.studioAutomation` — never on `config.studioAutomation` alone (phase 4, 8 Oct 2026). That
 * flag is also the dashboard's own switch for letting a real Chrome sign into the channel's
 * Google account from *its* container, which has no Chrome at all, so it must stay `false` there;
 * the operator's own words, his /goal, 7 Oct 2026: "the automation lives in the dashboard code,
 * not this session: when the usage limit hits, the channel keeps running" — but *this* loop runs
 * in the Claude container, started deliberately by a session with `nohup npm run studio --
 * worker --enable &`, which is the operator's own browser-automation grant exercised directly, not
 * a second, ungated path to the same browser the dashboard's flag was built to gate. Without
 * either, a cycle is still a no-op recorded as `"skipped"` — see CLAUDE.md.
 *
 * `scripts/studio-worker.sh` supervises this process (restarts it 60s after any exit, logs to
 * `~/.claude/studio-worker.log`): `runWorker` itself exits cleanly (code 0) at the start of its
 * nightly blackout — never mid-cycle, since no browser session is open there — when the repo's
 * live HEAD (`src/dashboard/repoHead.ts`) has moved past the one this process started on, so a
 * `git pull` into the same bind mount reaches the worker the same way a dashboard restart reaches
 * the dashboard (`newCodeWaiting`, `BOOT_HEAD` below).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  abTestsPausedNow,
  endScreenRivalryNow,
  blockedIn,
  communityPollsNow,
  config,
  CONFIG_PATH,
  DEFAULTS,
  matchDir,
  reloadBlockedPlayers,
} from "../config.js";
import { blockedOnDisk } from "../dashboard/matchStatus.js";
import { repoHead } from "../dashboard/repoHead.js";
import { describeError } from "../errorText.js";
import { matchIsDnf } from "../playoffs/playoffs.js";
import {
  pollContentFor,
  pollTargets,
  postCommunityPoll,
  readCommunityPosts,
  recordCommunityPost,
  type PollCandidate,
} from "./studioCommunity.js";
import {
  addEndScreenFromTemplate,
  addRivalryEndScreen,
  linkRelatedVideo,
  pinComment,
  readTestAndCompare,
  startTestAndCompare,
  titleTestProblem,
  type TcReadResult,
  type TcTest,
} from "./studioActions.js";
import { probe, start, type StudioBrowserOptions } from "./studioBrowser.js";
import {
  importTcPlan,
  readExperiments,
  updateTcExperiments,
  type Experiment,
  type ExperimentArm,
  type TcPlanThumbEntry,
} from "./studioExperiments.js";
import { SEPARATOR } from "../pipeline/title.js";
import { findPlaylistId, matchupPlaylistTitle, videoStats } from "./youtube.js";
import {
  allShortUploads,
  allUploads,
  readUpload,
  samePairLongForm,
  splitTitle,
  writeUpload,
} from "./youtubeStore.js";

/** The operator's own end-screen template, set up by hand once (CLAUDE.md, the task's own FACTS). */
export const END_SCREEN_TEMPLATE_VIDEO_ID = "POQrpE0-5d8";
/** A long-form uploaded on or after this date is a candidate even while still private/scheduled. */
export const END_SCREEN_CUTOFF_ISO = "2026-10-07T00:00:00.000Z";
export const MAX_ENDSCREENS_PER_CYCLE = 3;
export const MAX_TC_STARTS_PER_CYCLE = 2;
/** A long-form uploaded by the chain on or after this date gets its own auto-planned thumbnail
 * Test & Compare (phase 4, 8 Oct 2026) — the day this feature shipped; nothing retroactive. */
export const THUMBNAIL_TC_CUTOFF_ISO = "2026-10-08T00:00:00.000Z";
export const MAX_THUMBNAIL_PLANS_PER_CYCLE = 2;
/** A dashboard long-form uploaded on or after this date gets its title tested too (18 Oct 2026,
 * the Telegram title picker) — nothing retroactive, same shape as `THUMBNAIL_TC_CUTOFF_ISO`. */
export const TITLE_TC_CUTOFF_ISO = "2026-10-18T00:00:00.000Z";
export const MAX_TITLE_PLANS_PER_CYCLE = 2;
/** Title-only mode's dialog has one live slot plus at most 2 challenger slots (CLAUDE.md's
 *  "Phase 2/3" facts) — the ceiling on how many `title-options.json` options become arms. */
export const MAX_TITLE_CHALLENGERS = 2;
/** Phase 5, 8 Oct 2026: the worker pins a PUBLIC long-form's own channel comment itself, the same
 * `finished.pin` ledger step `finishOnYouTube` (`src/youtube/youtubeUpload.ts`) uses — gated there
 * on `config.studioAutomation`, off, since the dashboard has no Chrome. Capped per cycle for the
 * same reason the other Studio actions are: a cold start with many unpinned videos must not spend
 * a whole cycle here. */
export const MAX_PINS_PER_CYCLE = 3;
/** The task's own cap (11 Oct 2026): at most this many related-video links a cycle, same shape as
 *  every other Studio action's own per-cycle ceiling. */
export const MAX_RELATED_LINKS_PER_CYCLE = 3;
/** The caption arm only ships in this fully-automated flow when it is this short. A judge reads
 * every caption in the manual tc-plan.json flow (CLAUDE.md's "Phase 2/3"); nobody reviews this
 * one before it goes live on real viewers' thumbnails, so the ceiling here is tighter than
 * tcCaption.ts's own CAPTION_MAX_CHARS (9, the 8 Oct 2026 chip-truth fix) — "a caption is a clean
 * token or nothing" applies twice over when nobody is there to catch a borderline one. */
export const AUTO_CAPTION_MAX_CHARS = 6;
const CYCLE_MS = 20 * 60 * 1000;
const JITTER_MS = 3 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Ledger: what the worker has already done (`.studio-ledger.json`, atomic).
// ---------------------------------------------------------------------------

export interface StudioLedger {
  /** `layout` is absent on a record written before the 19 Oct 2026 retention proposal, and on
   *  "already-has-endscreen" (never this worker's own layout to name) — the A/B readout
   *  (`ab-report`) reads it to compare the same-rivalry layout against the plain starter template. */
  endScreens: Record<string, { at: string; matchId: number; layout?: "rivalry" | "starter" }>;
  /** The last UTC calendar date a video hit the picker's own confirmed account-scoping bug
   * (`"picker-empty"`) — not "done" (worth trying again once the bug is fixed), but bounds the
   * retry to once a day instead of every ~20 min cycle (added 8 Oct 2026: before this, a
   * standing `picker-empty` candidate re-opened the editor, and its two screenshots, on every
   * single cycle for as long as the bug lasts). */
  pickerEmptySeen: Record<string, string>;
  /** Short video id -> what it was linked to and when (11 Oct 2026) — `"already-linked"` marks
   *  this done too, the same "a fact true on the server is done regardless of who set it" rule
   *  `endScreens` already keeps, so a Short linked by hand is never re-opened to check.
   *  `longFormVideoId` is only ever the real target when *this* worker did the linking
   *  (`"linked"`): `"already-linked"` only confirms the field is non-empty, never that it names
   *  our own match's long-form, so that branch records `null` rather than assert an unverified
   *  value (silent-failure review, 11 Oct 2026). */
  relatedLinks: Record<string, { at: string; matchId: number; longFormVideoId: string | null }>;
  /** Same "once a UTC day" shape as `pickerEmptySeen`, for a Short whose search came back
   *  `"picker-empty"` or `"not-found"` this day. */
  relatedRetrySeen: Record<string, string>;
}

const ledgerPath = (): string => path.join(config.mediaDir, ".studio-ledger.json");

// A fresh literal every call — callers (markEndScreenDone and friends) mutate the object they get
// back in place before writing it, so a shared singleton here would leak one call's mutation into
// the next "file doesn't exist yet" read.
const emptyLedger = (): StudioLedger => ({
  endScreens: {},
  pickerEmptySeen: {},
  relatedLinks: {},
  relatedRetrySeen: {},
});

export async function readLedger(): Promise<StudioLedger> {
  const file = ledgerPath();
  if (!existsSync(file)) return emptyLedger();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<StudioLedger>;
    return {
      endScreens: parsed.endScreens ?? {},
      pickerEmptySeen: parsed.pickerEmptySeen ?? {},
      relatedLinks: parsed.relatedLinks ?? {},
      relatedRetrySeen: parsed.relatedRetrySeen ?? {},
    };
  } catch {
    // ponytail: a corrupt ledger just means "nothing recorded yet" — `addRivalryEndScreen`
    // checks the live editor for an existing end screen itself, so losing this file risks one
    // redundant (and safe) check per video, never a duplicate import.
    return emptyLedger();
  }
}

export async function writeLedger(ledger: StudioLedger): Promise<void> {
  mkdirSync(config.mediaDir, { recursive: true });
  const target = ledgerPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2));
  await rename(tmp, target);
}

export async function markEndScreenDone(
  videoId: string,
  matchId: number,
  layout?: "rivalry" | "starter",
): Promise<void> {
  const ledger = await readLedger();
  ledger.endScreens[videoId] = { at: new Date().toISOString(), matchId, ...(layout ? { layout } : {}) };
  await writeLedger(ledger);
}

export async function markPickerEmptySeen(videoId: string, now: Date = new Date()): Promise<void> {
  const ledger = await readLedger();
  ledger.pickerEmptySeen[videoId] = now.toISOString();
  await writeLedger(ledger);
}

export async function markRelatedLinkDone(
  shortVideoId: string,
  matchId: number,
  longFormVideoId: string | null,
): Promise<void> {
  const ledger = await readLedger();
  ledger.relatedLinks[shortVideoId] = { at: new Date().toISOString(), matchId, longFormVideoId };
  await writeLedger(ledger);
}

export async function markRelatedRetrySeen(shortVideoId: string, now: Date = new Date()): Promise<void> {
  const ledger = await readLedger();
  ledger.relatedRetrySeen[shortVideoId] = now.toISOString();
  await writeLedger(ledger);
}

// ---------------------------------------------------------------------------
// Heartbeat: `.studio-worker.json`, so the morning report can say if the worker died.
// ---------------------------------------------------------------------------

export interface WorkerHeartbeat {
  pid: number;
  at: string;
  lastCycle: {
    at: string;
    probe: string;
    endScreensAdded: number;
    /** Hit the picker's own confirmed account-scoping bug this cycle (8 Oct 2026) — distinct
     * from `endScreensAdded: 0` with no error, which otherwise looks identical to "nothing to
     * do" on every cycle for as long as the bug lasts; a human watching the heartbeat for a week
     * needs to be able to tell those two apart. */
    endScreenPickerEmpty: number;
    tcStarted: number;
    tcChecked: number;
    thumbnailTestsPlanned: number;
    /** See `CycleResult.titleTestsPlanned` (18 Oct 2026). */
    titleTestsPlanned: number;
    /** PUBLIC long-forms whose channel comment was pinned this cycle (phase 5, 8 Oct 2026). */
    pinsAdded: number;
    /** Shorts whose "Related video" was linked (new or already there) this cycle (11 Oct 2026). */
    relatedLinksAdded: number;
    /** Community polls posted this cycle (22 Oct 2026, `communityPolls`); absent before then. */
    pollsPosted?: number;
  } | null;
  /** The first error of the cycle, kept for anything that only ever read this one field. */
  lastError: string | null;
  /** Every error the cycle collected, not just the first — `tcStarted`/`tcChecked` can each
   * contribute one independently of an end-screen error, and truncating to `errors[0]` silently
   * dropped the rest (fixed 8 Oct 2026). */
  lastErrors: string[];
  /** How many consecutive cycles have now ended with this exact `lastError` (0 when this cycle
   * had none) — computed read-before-write in `runWorker` so a caller (the morning report's
   * "Needs you") can notice a standing problem without keeping its own history. Optional only
   * for a heartbeat file written before this field existed. */
  sameErrorStreak?: number;
}

const heartbeatPath = (): string => path.join(config.mediaDir, ".studio-worker.json");

export async function writeHeartbeat(hb: WorkerHeartbeat): Promise<void> {
  mkdirSync(config.mediaDir, { recursive: true });
  const target = heartbeatPath();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(hb, null, 2));
  await rename(tmp, target);
}

export async function readHeartbeat(): Promise<WorkerHeartbeat | null> {
  const file = heartbeatPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as WorkerHeartbeat;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure planning — no browser, no fs — so "what does this cycle do" is a plain unit test.
// ---------------------------------------------------------------------------

export interface LongFormRef {
  videoId: string;
  matchId: number;
  uploadedAt: string;
  privacyStatus: string;
  /** The scheduled publish time the chain uploaded with — once it has passed, a record still
   *  reading `privacyStatus: "private"` (upload-time only, never updated) is public. */
  publishAt?: string | null;
  /** Absent on a record written before source tracking existed (`UploadRecord.source`,
   *  youtubeStore.ts) — the auto-thumbnail-test filter below only ever matches `"dashboard"`. */
  source?: "dashboard" | "studio";
  /** `record.finished?.comment`/`.pin` off youtubeStore's own `FinishedSteps` — read only by the
   *  pin plan below. `undefined` on either means that step has never been attempted. */
  finishedComment?: string | null;
  finishedPin?: string | null;
  /** The record's own stored title (`UploadRecord.title`) — only the title-test planner below
   *  reads this; every other target list ignores it. */
  title?: string;
}

/** `<matchDir>/title-options.json`, as the title-test planner needs it: the Telegram offer's own
 *  options and, when the cache carries them (titles/v2, optional on an older file), a parallel
 *  `styles` array. */
export interface TitleOptionsCache {
  options: string[];
  styles?: string[];
}

export interface TitleTcChallenger {
  /** The full title this challenger would ship, already past `titleTestProblem`. */
  title: string;
  style: string;
}

export interface TitleTcTarget {
  videoId: string;
  matchId: number;
  /** The video's current full title — becomes the control arm as is. */
  title: string;
  /** The saved hook's own style: the cache option it matches (same normalised compare that drops
   *  it from the challenger candidates), else `"picked"` when the saved hook isn't one of the
   *  cache's current options (a hand-typed title, or the cache since refreshed) — the operator's
   *  own choice still deserves a bucket in `ab-report`'s aggregation. */
  controlStyle: string;
  /** 1–2 challengers, already built and checked (see `planCycle`'s own title-target block). */
  challengers: TitleTcChallenger[];
}

export interface CyclePlan {
  /** Uncapped, like `pinTargets`: `endScreensThisCycle` caps after the day's "no-editor" skips. */
  endScreenTargets: LongFormRef[];
  tcToStart: Experiment[];
  tcToCheck: Experiment[];
  /** New dashboard-chain long-forms with no tc experiment of their own yet (phase 4, 8 Oct
   *  2026) — `runCycle` renders each one's thumbnail set and plans a "tc" experiment for it,
   *  which a *later* cycle's own `tcToStart` picks up, never this same cycle's. */
  thumbnailTcTargets: LongFormRef[];
  /** Dashboard long-forms with a `title-options.json` offering something other than the saved
   *  hook, no tc experiment yet, unblocked, public (18 Oct 2026) — capped at
   *  `MAX_TITLE_PLANS_PER_CYCLE`. A video that has `title-options.json` at all is excluded from
   *  `thumbnailTcTargets` above, title target or not: Studio runs one Test & Compare per video. */
  titleTcTargets: TitleTcTarget[];
  /** Comment posted, pin not done, not blocked (phase 5, 8 Oct 2026). Uncapped: `pinsThisCycle`
   *  caps at `MAX_PINS_PER_CYCLE` only after the day's skips and the live check — capping here
   *  first let three standing skips hold every slot (8–14 Oct 2026, no pin tried past them). Whether
   *  the video is actually public *right now* is left to `runCycle`'s own live check — the stored
   *  `privacyStatus` here is upload-time only and never updated (same reason `finishOnYouTube`'s
   *  own pin step re-checks live), so filtering on it here would leave a scheduled upload that
   *  only went public after the fact permanently unpinned. */
  pinTargets: LongFormRef[];
  /** Shorts to link to their own match's long-form (11 Oct 2026), capped at
   *  `MAX_RELATED_LINKS_PER_CYCLE`. No privacy filter on either side on purpose — the operator's
   *  own instruction: a scheduled private Short can be linked before it goes public. */
  relatedLinkTargets: RelatedLinkTarget[];
}

export interface RelatedLinkTarget {
  matchId: number;
  shortVideoId: string;
  longFormVideoId: string;
}

const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** "Once a day" per running experiment, by UTC calendar date rather than exact elapsed hours —
 * robust against the worker's own ±3 min cycle jitter ever skipping a day by a cycle's width. */
function needsDailyCheck(e: Experiment, now: Date): boolean {
  const checkedAt = (e.result as { checkedAt?: string } | undefined)?.checkedAt;
  return !checkedAt || utcDate(new Date(checkedAt)) !== utcDate(now);
}

/** Same "once a day" shape as `needsDailyCheck`, for a video that already hit the picker's own
 * confirmed bug this UTC day — worth trying again a future cycle (the bug may get fixed), not
 * every ~20 min cycle in the meantime. */
function pickerEmptyToday(videoId: string, ledger: StudioLedger, now: Date): boolean {
  const seenAt = ledger.pickerEmptySeen[videoId];
  return !!seenAt && utcDate(new Date(seenAt)) === utcDate(now);
}

/** Same shape as `pickerEmptyToday`, for a Short whose related-video search already came back
 * `"picker-empty"` or `"not-found"` this UTC day. */
function relatedRetryToday(shortVideoId: string, ledger: StudioLedger, now: Date): boolean {
  const seenAt = ledger.relatedRetrySeen[shortVideoId];
  return !!seenAt && utcDate(new Date(seenAt)) === utcDate(now);
}

/** The real "is this match's own POV footage a blocked runner's" check (CLAUDE.md's "Blocked
 * players") — `planCycle`'s own default, overridable by a test with a plain stub so the rest of
 * its logic stays a pure, filesystem-free unit test. */
const realIsBlocked = (matchId: number): boolean => blockedOnDisk(matchDir(matchId));

/** `planCycle`'s own default for reading `<matchDir>/title-options.json` — a missing or corrupt
 *  cache reads as `null` ("no title-options.json"), same "a bad file is no worse than no file"
 *  rule every other cache in this codebase follows. Overridable by a test the same way
 *  `realIsBlocked` is. */
function realTitleOptionsFor(matchId: number): TitleOptionsCache | null {
  const file = path.join(matchDir(matchId), "title-options.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { options?: unknown; styles?: unknown };
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === "string")
      : [];
    const styles = Array.isArray(parsed.styles)
      ? parsed.styles.filter((s): s is string => typeof s === "string")
      : undefined;
    return { options, ...(styles ? { styles } : {}) };
  } catch {
    return null;
  }
}

/** Upload-time `privacyStatus` is never updated after the fact, so a scheduled upload whose
 *  publish time has passed counts as public too — the same reading `endScreenTargets` uses below. */
const looksPublicNow = (v: LongFormRef, now: Date): boolean =>
  v.privacyStatus === "public" || (!!v.publishAt && Date.parse(v.publishAt) <= now.getTime());

export function planCycle(
  now: Date,
  longForms: readonly LongFormRef[],
  ledger: StudioLedger,
  experiments: readonly Experiment[],
  isBlocked: (matchId: number) => boolean = realIsBlocked,
  shorts: readonly { matchId: number; videoId: string }[] = [],
  live: ReadonlyMap<string, { privacyStatus: string; publishAt: string | null }> | null = null,
  testsPaused = false,
  titleOptionsFor: (matchId: number) => TitleOptionsCache | null = realTitleOptionsFor,
): CyclePlan {
  // `live` is `runCycle`'s own videos.list read (16 Oct 2026: two adopted Studio uploads public on
  // YouTube for a month still read "private" with no publishAt, and Edj_-c7lK38, deleted, stayed
  // an end-screen target for good). It replaces the upload-time privacy, and a video it doesn't
  // return is gone from the channel: planned for nothing. `null` (no read, or it failed) plans
  // from the records alone, as before.
  if (live) {
    longForms = longForms.flatMap((v) => {
      const s = live.get(v.videoId);
      return s ? [{ ...v, privacyStatus: s.privacyStatus, publishAt: s.publishAt }] : [];
    });
    shorts = shorts.filter((s) => live.has(s.videoId));
  }
  const endScreenTargets = longForms
    .filter((v) => !ledger.endScreens[v.videoId])
    // `privacyStatus` is upload-time only and the chain always uploads private with a publishAt,
    // so a scheduled upload whose publish time has passed counts as public too.
    .filter(
      (v) =>
        v.uploadedAt >= END_SCREEN_CUTOFF_ISO ||
        v.privacyStatus === "public" ||
        (!!v.publishAt && Date.parse(v.publishAt) <= now.getTime()),
    )
    .filter((v) => !pickerEmptyToday(v.videoId, ledger, now))
    .filter((v) => !isBlocked(v.matchId));

  const tc = experiments.filter((e) => e.kind === "tc");
  // A test planned before its runner was blocked (or by hand with `tc-plan`) never starts.
  // `abTestsPaused`: nothing new starts or gets planned; running tests are still read below.
  const tcToStart = tc
    .filter(() => !testsPaused)
    .filter((e) => e.status === "planned" && !e.videos.some((v) => isBlocked(v.matchId)))
    .slice(0, MAX_TC_STARTS_PER_CYCLE);
  const tcToCheck = tc.filter((e) => e.status === "running" && needsDailyCheck(e, now));

  // "no tc experiment yet" (the task's own words) means any kind — Studio only ever runs one
  // Test & Compare per video at a time anyway, so a video already in a title test is not also
  // offered a thumbnail one.
  const alreadyTested = new Set(
    tc.flatMap((e) => e.videos.map((v) => v.videoId).filter((id): id is string => !!id)),
  );
  // One lookup per match, shared between the two target lists below.
  const titleCacheByMatch = new Map<number, TitleOptionsCache | null>();
  const titleCacheFor = (matchId: number): TitleOptionsCache | null => {
    if (!titleCacheByMatch.has(matchId)) titleCacheByMatch.set(matchId, titleOptionsFor(matchId));
    return titleCacheByMatch.get(matchId)!;
  };
  const thumbnailTcTargets = longForms
    .filter(() => !testsPaused)
    .filter((v) => v.source === "dashboard")
    .filter((v) => v.uploadedAt >= THUMBNAIL_TC_CUTOFF_ISO)
    .filter((v) => !alreadyTested.has(v.videoId))
    .filter((v) => !isBlocked(v.matchId))
    // Any video with a title-options.json loses its thumbnail test, title target this cycle or
    // not: Studio runs one Test & Compare per video at a time (CyclePlan.titleTcTargets' own doc).
    .filter((v) => titleCacheFor(v.matchId) === null)
    .slice(0, MAX_THUMBNAIL_PLANS_PER_CYCLE);

  // A title test for a new dashboard long-form whose title-options.json still offers something
  // other than the saved hook (18 Oct 2026, the Telegram title picker) — same eligibility shape
  // as thumbnailTcTargets, plus the cache and a "still public" check (a test's own watch-time
  // comparison needs real traffic, same reason `tcToCheck` below waits for public too).
  const titleTcTargets: TitleTcTarget[] = testsPaused
    ? []
    : longForms
        .filter((v) => v.source === "dashboard")
        .filter((v) => v.uploadedAt >= TITLE_TC_CUTOFF_ISO)
        .filter((v) => !alreadyTested.has(v.videoId))
        .filter((v) => !isBlocked(v.matchId))
        .filter((v) => looksPublicNow(v, now))
        .flatMap((v): TitleTcTarget[] => {
          if (!v.title) return [];
          const cache = titleCacheFor(v.matchId);
          if (!cache || cache.options.length === 0) return [];
          const sepIdx = v.title.indexOf(SEPARATOR);
          if (sepIdx === -1) return []; // no "<hook> | …" shape to rebuild challengers from
          const savedHook = v.title.slice(0, sepIdx).trim();
          const rest = v.title.slice(sepIdx + SEPARATOR.length);
          const parts = splitTitle(v.title);
          if (!parts) return []; // no "<a> vs <b>" names — titleTestProblem has nobody to check against
          const players = [{ nickname: parts.left }, { nickname: parts.right }];
          // The operator's own pick was one of the cache's options too (unless it was hand-typed,
          // or the cache has since refreshed) — same normalised compare used to drop it from the
          // challenger candidates below, so `ab-report` can say whether a pick beats what it skipped.
          const savedHookIdx = cache.options.findIndex((o) => o.trim() === savedHook);
          const controlStyle = savedHookIdx === -1 ? "picked" : (cache.styles?.[savedHookIdx] ?? "unknown");
          const challengers: TitleTcChallenger[] = [];
          for (let i = 0; i < cache.options.length && challengers.length < MAX_TITLE_CHALLENGERS; i++) {
            if (i === savedHookIdx) continue;
            const option = cache.options[i]!.trim();
            if (option === "") continue;
            const title = `${option}${SEPARATOR}${rest}`;
            if (titleTestProblem(title, players)) continue;
            challengers.push({ title, style: cache.styles?.[i] ?? "unknown" });
          }
          return challengers.length
            ? [{ videoId: v.videoId, matchId: v.matchId, title: v.title, controlStyle, challengers }]
            : [];
        })
        .slice(0, MAX_TITLE_PLANS_PER_CYCLE);

  // Same `todo()` reading `finishOnYouTube` already uses for this field: `null` is done, a
  // string is a failed attempt worth retrying, `undefined` is never attempted — either of the
  // last two is still "to do". A blocked player's match is excluded by `isBlocked` here: nothing
  // in `allUploads()` is blocked-aware, and a comment posted before the block left its
  // `finishedComment` at `null` (8 Oct 2026: end screens went onto four blocked runners' videos).
  // A series copies this same `youtube.json` (same videoId, same `finished`) into every game's own
  // folder, but `markPinDone` below only ever writes the one matchId it pinned through — so once
  // one copy reads back `null`, every *other* copy of that same videoId must still be excluded, not
  // just de-duped within this one cycle (`pendingPins()`'s own OR-merge, src/youtube/
  // youtubeUpload.ts, reads the same series shape the same way): without this, a later cycle finds
  // the still-undone copy, re-opens the real (already-pinned) video for nothing, and only converges
  // after as many extra cycles as the series has games — each one spending a `MAX_PINS_PER_CYCLE`
  // slot a genuinely pending video could have used instead.
  const pinnedDoneVideoIds = new Set(longForms.filter((v) => v.finishedPin === null).map((v) => v.videoId));
  const seenPinVideos = new Set<string>();
  const pinTargets = longForms
    .filter((v) => v.finishedComment === null && v.finishedPin !== null && !pinnedDoneVideoIds.has(v.videoId))
    .filter((v) => !isBlocked(v.matchId))
    .filter((v) => {
      if (seenPinVideos.has(v.videoId)) return false;
      seenPinVideos.add(v.videoId);
      return true;
    });

  // Every Short whose own match also has a long-form, not yet linked (either for real or
  // already, by hand) or seen empty/not-found today, not blocked — the task's own words (11 Oct
  // 2026): no privacy filter on either side, a scheduled private Short can be linked before it
  // goes public. De-duped by Short video id the same defensive way `pinTargets` is, in case a
  // Short record is ever copied across more than one match directory the way a series' own
  // `youtube.json` already is.
  const longFormByMatch = new Map(longForms.map((v) => [v.matchId, v]));
  const seenShortVideos = new Set<string>();
  const relatedLinkTargets: RelatedLinkTarget[] = shorts
    .filter((s) => !ledger.relatedLinks[s.videoId])
    .filter((s) => !relatedRetryToday(s.videoId, ledger, now))
    .filter((s) => longFormByMatch.has(s.matchId))
    .filter((s) => !isBlocked(s.matchId))
    .filter((s) => {
      if (seenShortVideos.has(s.videoId)) return false;
      seenShortVideos.add(s.videoId);
      return true;
    })
    .map((s) => ({
      matchId: s.matchId,
      shortVideoId: s.videoId,
      longFormVideoId: longFormByMatch.get(s.matchId)!.videoId,
    }))
    .slice(0, MAX_RELATED_LINKS_PER_CYCLE);

  return {
    endScreenTargets,
    tcToStart,
    tcToCheck,
    thumbnailTcTargets,
    titleTcTargets,
    pinTargets,
    relatedLinkTargets,
  };
}

/** The end screens one cycle actually tries: not skipped today ("no-editor"), then capped at
 * `MAX_ENDSCREENS_PER_CYCLE` — after the skip, so a dead video never holds a slot (14 Oct 2026). */
export function endScreensThisCycle(
  targets: readonly LongFormRef[],
  skippedToday: (videoId: string) => boolean,
): LongFormRef[] {
  return targets.filter((t) => !skippedToday(t.videoId)).slice(0, MAX_ENDSCREENS_PER_CYCLE);
}

/** The pins one cycle actually tries: not already skipped today, live public, then capped at
 * `MAX_PINS_PER_CYCLE` — the cap counts real `pinComment` calls, so it comes after both skips. */
export function pinsThisCycle(
  targets: readonly LongFormRef[],
  isPublicNow: (videoId: string) => boolean,
  skippedToday: (videoId: string) => boolean,
): LongFormRef[] {
  return targets
    .filter((t) => !skippedToday(t.videoId) && isPublicNow(t.videoId))
    .slice(0, MAX_PINS_PER_CYCLE);
}

const MINUTES_PER_DAY = 24 * 60;
/** 10 minutes of lead-in before `nightlyRenderHourUtc` (`sweepArchive` and friends run ahead of
 * the render itself) plus the 4-hour chain window `nightlyMaxRenders` above 1 can use
 * (`CHAIN_WINDOW_MS`, `src/dashboard/nightly.ts`) plus 30 minutes for that last chained render to
 * actually finish (lab timings: ~12-21 min). */
const BLACKOUT_WINDOW_MIN = 10 + 4 * 60 + 30;

/**
 * The nightly render's own window (CLAUDE.md "The NAS", `inNasWindow`'s sibling): Chrome and
 * ffmpeg share the lab's four cores, so the worker simply does not run here. Read live from
 * `config.nightlyRenderHourUtc` (default 3, a Settings-tab field `scheduleNightly` re-reads on
 * every arm with no restart) rather than a hardcoded 02:50-04:30 — fixed 8 Oct 2026, since a
 * hardcoded window silently desynced from an operator's hour change, and was narrower than a
 * chained nightly render (`nightlyMaxRenders` above 1) can actually run late into. `null`
 * (nightly disabled) turns the blackout off too — nothing to avoid colliding with.
 */
export function inBlackoutWindow(now: Date, hourUtc: number | null = config.nightlyRenderHourUtc): boolean {
  if (hourUtc === null) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = (((hourUtc * 60 - 10) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const sinceStart = (((minutes - start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return sinceStart <= BLACKOUT_WINDOW_MIN;
}

/**
 * The nightly hour as mcsr-vid.config.json says right now, for `runWorker`'s blackout. The worker
 * is its own long-lived process, and a Settings-tab or experiment move of the hour (`saveSettings`)
 * rewrites the file but updates only the dashboard's in-memory `config` — read at boot, this kept
 * blacking out the old hours and opened Chrome during the moved render. A missing file or key is
 * `DEFAULTS` (what `loadConfig` does); an unreadable file (mid-write) or a bad value keeps the
 * hour this process booted with.
 */
export function liveNightlyHour(file: string = CONFIG_PATH): number | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!("nightlyRenderHourUtc" in raw)) return DEFAULTS.nightlyRenderHourUtc;
    const h = raw.nightlyRenderHourUtc;
    return h === null || (Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23)
      ? (h as number | null)
      : config.nightlyRenderHourUtc;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? DEFAULTS.nightlyRenderHourUtc
      : config.nightlyRenderHourUtc;
  }
}

/** The two single-variable `TcTest`s `startTestAndCompare` accepts, built from an experiment's
 * own arms — null when the experiment carries neither a usable title nor thumbnail set, which
 * `runCycle` reports as an error rather than silently skip. */
export function testFor(exp: Experiment): TcTest | null {
  const control = exp.controlArm ?? "control";
  if (exp.variable === "title") {
    const titles = exp.arms
      .filter((a) => a.name !== control)
      .map((a) => (a.settings as { title?: string } | undefined)?.title)
      .filter((t): t is string => !!t);
    return titles.length ? { kind: "title", titles } : null;
  }
  if (exp.variable === "thumbnail") {
    const files = exp.arms
      .map((a) => (a.settings as { file?: string } | undefined)?.file)
      .filter((f): f is string => !!f);
    return files.length >= 2 ? { kind: "thumbnail", files } : null;
  }
  return null;
}

/** The two nicknames a title experiment's control arm names, read the same way every title check
 * in this codebase does (`splitTitle`) — empty for a thumbnail experiment, which needs none. */
export function playersFor(exp: Experiment): { nickname: string }[] {
  const control = exp.arms.find((a) => a.name === (exp.controlArm ?? "control"));
  const liveTitle = (control?.settings as { title?: string } | undefined)?.title;
  const parts = liveTitle ? splitTitle(liveTitle) : null;
  return parts ? [{ nickname: parts.left }, { nickname: parts.right }] : [];
}

// ---------------------------------------------------------------------------
// IO: one cycle, one browser session.
// ---------------------------------------------------------------------------

async function setNeedsHuman(id: string, reason: string): Promise<void> {
  await updateTcExperiments((tc) => tc.map((e) => (e.id === id ? { ...e, needsHuman: reason } : e)));
}

/** Writes `finished.pin = null` (done) to this one match's own `youtube.json` — the exact field
 * `finishOnYouTube`'s `todo("pin")` reads, so a later tick of either path sees this pin as done
 * rather than attempting it again. A gone record (deleted between the plan and the pin) is left
 * alone — nothing to mark. */
/** Videos whose pin came back "no-channel-comment"/"skipped-private", by the UTC day it did — skipped
 *  for the rest of that day instead of re-tried (and re-reported) every cycle. */
const pinSkippedOn = new Map<string, string>();
/** Same, for an end screen whose video page showed no editor ("no-editor": deleted, or not ours). */
const endScreenSkippedOn = new Map<string, string>();

async function markPinDone(matchId: number): Promise<void> {
  const record = await readUpload(matchId, "video");
  if (!record) return;
  await writeUpload(matchId, { ...record, finished: { ...record.finished, pin: null } }, "video");
}

async function setExperimentRunning(id: string): Promise<void> {
  await updateTcExperiments((tc) =>
    tc.map((e) => (e.id === id ? { ...e, status: "running", start: new Date().toISOString() } : e)),
  );
}

/**
 * Records what `readTestAndCompare` saw, for both of its callers: the daily check of an
 * already-`"running"` experiment (the only caller before 8 Oct 2026), and — since phase 4 —
 * reconciling a `"planned"` one the `tcToStart` loop below finds *already* running live (started
 * outside this bookkeeping entirely, e.g. a manual `npm run studio -- tc` CLI press before the
 * experiment ever existed — exactly LUI5E7yF0zE's own history). Either way, `"running"`/`"done"`
 * read off the real page always wins over whatever status this experiment already had — a
 * `"planned"` experiment is promoted to `"running"` (with a `start` it may not have had yet)
 * rather than left `"planned"` with no indication Studio has already started it, which would
 * otherwise never again be picked up by `tcToCheck`'s own `status === "running"` filter.
 */
/**
 * A daily read that failed still counts as that day's check (`result.checkedAt`), so the next try is
 * tomorrow, not every ~20 min cycle — 8 Oct 2026: a title test on a still-scheduled video
 * (la_h_HmMuF8) has no readable A/B dialog until it goes public, and the retry-every-cycle ran the
 * same error 20 times. Only a second day's failure in a row asks for a human.
 */
export async function setExperimentReadFailed(id: string, error: string): Promise<void> {
  const checkedAt = new Date().toISOString();
  await updateTcExperiments((tc) =>
    tc.map((e) => {
      if (e.id !== id) return e;
      const prev = e.result as { readError?: string; readErrorSince?: string } | undefined;
      // "Two days running" means two failures at least 20 h apart — a read just before and just
      // after UTC midnight is one bad evening, not two days (9 Oct 2026: 00:10 after 18:30).
      const since = prev?.readError ? (prev.readErrorSince ?? checkedAt) : checkedAt;
      const longStanding = Date.parse(checkedAt) - Date.parse(since) >= 20 * 3600_000;
      return {
        ...e,
        result: { ...(e.result as object), checkedAt, readError: error, readErrorSince: since },
        ...(longStanding ? { needsHuman: `${READ_FAILED_PREFIX} ${error.split("\n")[0]}` } : {}),
      };
    }),
  );
}

/** The start of a read-failure streak's `needsHuman`; a later good read clears exactly this flag. */
const READ_FAILED_PREFIX = "A/B test could not be read two days running:";

export async function setExperimentChecked(id: string, read: TcReadResult): Promise<void> {
  const checkedAt = new Date().toISOString();
  await updateTcExperiments((tc) =>
    tc.map((e) => {
      if (e.id !== id) return e;
      // A running test that reads back as the blank "set up a new test" form never took (the
      // page Save can miss without an error) — flag it, keep the status, never re-plan it here.
      if (read.state === "none")
        return {
          ...e,
          result: { checkedAt, raw: read.raw },
          needsHuman: "Studio shows no A/B test on this video — the start did not take",
        };
      // A good read ends a read-failure streak's flag (19 Oct 2026: five tests timed out together
      // under load and kept their "could not be read" Needs-you line after reading fine again).
      if (typeof e.needsHuman === "string" && e.needsHuman.startsWith(READ_FAILED_PREFIX)) {
        const { needsHuman: _cleared, ...rest } = e;
        e = rest as typeof e;
      }
      if (read.state !== "done")
        return { ...e, status: "running", start: e.start ?? checkedAt, result: { checkedAt, raw: read.raw } };
      // The report lists variants in slot order (slot 1 = control); a title test's own titles
      // name the arm outright when they match, so a reordered report cannot credit the wrong arm.
      const armOf = (slot: number) =>
        e.arms.find((a) => {
          const title = (a.settings as { title?: string } | undefined)?.title;
          return title !== undefined && title === read.titles?.[slot - 1];
        })?.name ??
        e.arms[slot - 1]?.name ??
        `variant ${slot}`;
      const shares = read.shares ?? [];
      const watchTimeShare = Object.fromEntries(shares.map((s, i) => [armOf(i + 1), s]));
      const winner = read.winnerSlot ? armOf(read.winnerSlot) : undefined;
      const split = shares.map((s) => `${s}%`).join(" vs ");
      return {
        ...e,
        status: "done",
        end: checkedAt,
        // YouTube's own winner is the live title/thumbnail it already applied — this never sets
        // one by hand, only records what `readTestAndCompare` read off the real page.
        result: {
          checkedAt,
          winner: winner ?? read.winner,
          ...(read.winnerSlot && read.titles ? { winnerTitle: read.titles[read.winnerSlot - 1] } : {}),
          ...(shares.length ? { watchTimeShare } : {}),
          ...(read.headline ? { headline: read.headline } : {}),
          raw: read.raw,
        },
        verdict: winner
          ? `${winner} wins: ${split} watch time share`
          : read.winner
            ? `YouTube applied: ${read.winner}`
            : shares.length
              ? `no winner${read.headline ? ` (Studio: "${read.headline}")` : ""}: ${split} watch time share`
              : "done (no winner text read)",
      };
    }),
  );
}

interface TcThumbResult {
  matchId: number;
  files: string[];
  caption: string | null;
}

/**
 * Spawns the existing `npm run tc-thumbs` (src/thumbnails/tcThumbs.ts) for one match — reused
 * rather than reimplemented, the same way `startFastExport` (src/dashboard/exportRoutes.ts)
 * shells out to `npm run export:fast` for its own heavy render instead of calling into it as a
 * library. Its own logic already gives exactly what the task asks for: control + the
 * most-different non-result-looking pose + a caption only when one passes its checks — this
 * worker adds nothing on top except, in `runCycle`, dropping the caption arm when it is longer
 * than `AUTO_CAPTION_MAX_CHARS`.
 */
function renderTcThumbSet(matchId: number): Promise<TcThumbResult | { error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["run", "--silent", "tc-thumbs", "--", String(matchId)], {
      cwd: path.resolve(new URL("../..", import.meta.url).pathname),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", (e) => resolve({ error: describeError(e) }));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ error: `tc-thumbs exit ${code}: ${err.slice(-500) || "(no stderr)"}` });
        return;
      }
      try {
        const results = JSON.parse(out) as TcThumbResult[];
        const result = results.find((r) => r.matchId === matchId);
        resolve(result ?? { error: "tc-thumbs produced no result for this match" });
      } catch (parseErr) {
        resolve({ error: `tc-thumbs output did not parse as JSON: ${describeError(parseErr)}` });
      }
    });
  });
}

export interface CycleResult {
  probe: string;
  endScreensAdded: number;
  /** See `WorkerHeartbeat.lastCycle.endScreenPickerEmpty`. */
  endScreenPickerEmpty: number;
  tcStarted: number;
  tcChecked: number;
  /** New dashboard long-forms whose thumbnail set got rendered and a "tc" experiment planned for
   *  this cycle (phase 4, 8 Oct 2026) — distinct from `tcStarted`, since the plan always waits for
   *  a *later* cycle's own `tcToStart` (see `CyclePlan.thumbnailTcTargets`'s own comment). */
  thumbnailTestsPlanned: number;
  /** New dashboard long-forms whose `title-options.json` got turned into a "tc" title experiment
   *  this cycle (18 Oct 2026) — same "waits for a later cycle's `tcToStart`" shape as
   *  `thumbnailTestsPlanned`. */
  titleTestsPlanned: number;
  /** PUBLIC long-forms whose channel comment was pinned this cycle (phase 5, 8 Oct 2026). */
  pinsAdded: number;
  /** Shorts whose "Related video" was linked (new or already there) this cycle (11 Oct 2026). */
  relatedLinksAdded: number;
  /** "WHO TAKES IT?" polls posted this cycle (22 Oct 2026, `config.communityPolls`). */
  pollsPosted: number;
  errors: string[];
}

const SKIPPED_RESULT: CycleResult = {
  probe: "skipped",
  endScreensAdded: 0,
  endScreenPickerEmpty: 0,
  tcStarted: 0,
  tcChecked: 0,
  thumbnailTestsPlanned: 0,
  titleTestsPlanned: 0,
  pinsAdded: 0,
  relatedLinksAdded: 0,
  pollsPosted: 0,
  errors: [],
};

/**
 * One cycle: probe, then at most `MAX_ENDSCREENS_PER_CYCLE` end screens and
 * `MAX_TC_STARTS_PER_CYCLE` new Test & Compare starts, then a daily check of every running one —
 * all in the one browser session `start()`/`handle.stop()` bracket. A non-`ok` probe ends the
 * cycle immediately, per the plan's own "no retry loop" rule; `probe()` itself already writes
 * `.studio-probe.json` for the nightly strip to read.
 */
export async function runCycle(
  opts: { dryRun?: boolean; startOpts?: StudioBrowserOptions; enable?: boolean } = {},
): Promise<CycleResult> {
  if (!opts.enable && !config.studioAutomation) return SKIPPED_RESULT;

  const errors: string[] = [];
  const handle = await start(opts.startOpts);
  try {
    const probed = await probe(handle);
    if (probed.result !== "ok") {
      return {
        ...SKIPPED_RESULT,
        probe: probed.result,
        errors: [`Studio ${probed.result}: ${probed.title}`],
      };
    }

    const longForms: LongFormRef[] = (await allUploads()).map(({ matchId, record }) => ({
      videoId: record.videoId,
      matchId,
      uploadedAt: record.uploadedAt,
      privacyStatus: record.privacyStatus,
      publishAt: record.publishAt,
      source: record.source,
      finishedComment: record.finished?.comment,
      finishedPin: record.finished?.pin,
      title: record.title,
    }));
    const shorts = (await allShortUploads()).map(({ matchId, record }) => ({
      matchId,
      videoId: record.videoId,
    }));
    // One videos.list per 50 ids (1 quota unit each). A failed read never skips the cycle.
    const live = await videoStats([...longForms, ...shorts].map((v) => v.videoId)).then(
      (stats) =>
        new Map(
          stats.map((s) => [
            s.videoId,
            { privacyStatus: s.privacyStatus, publishAt: s.publishAt, publishedAt: s.publishedAt },
          ]),
        ),
      (err) => {
        console.error(
          `studio worker: live video status unread, planning from the upload records: ${describeError(err)}`,
        );
        return null;
      },
    );
    const ledger = await readLedger();
    const experimentsFile = await readExperiments();
    const plan = planCycle(
      new Date(),
      longForms,
      ledger,
      experimentsFile.experiments,
      undefined,
      shorts,
      live,
      abTestsPausedNow(),
    );

    let endScreensAdded = 0;
    let endScreenPickerEmpty = 0;
    const today = utcDate(new Date());
    const endScreens = endScreensThisCycle(
      plan.endScreenTargets,
      (id) => endScreenSkippedOn.get(id) === today,
    );
    for (const target of endScreens) {
      // Same-rivalry layout (19 Oct 2026 retention proposal): the most recent other public
      // long-form of this pair, and the matchup playlist only when one already exists on the
      // channel (a first meeting has none — `playlistTitlesFor`'s own rule). Both are hints
      // `addRivalryEndScreen` is free to find nothing for; neither reaching YouTube at all here.
      const rivalVideoId = await samePairLongForm(target.matchId, target.title ?? "", target.videoId);
      const titleParts = target.title ? splitTitle(target.title) : null;
      const matchupTitle = titleParts ? matchupPlaylistTitle(titleParts.left, titleParts.right) : null;
      const playlistTitle = matchupTitle && (await findPlaylistId(matchupTitle)) ? matchupTitle : null;
      // Off until a live Studio check confirms the custom "+ Element" selectors (`endScreenRivalry`,
      // config file only): until then the starter layout, as before, recorded as such.
      const outcome = endScreenRivalryNow()
        ? await addRivalryEndScreen(handle, target.videoId, END_SCREEN_TEMPLATE_VIDEO_ID, {
            matchId: target.matchId,
            rivalVideoId,
            playlistTitle,
            dryRun: opts.dryRun,
          })
        : await addEndScreenFromTemplate(handle, target.videoId, END_SCREEN_TEMPLATE_VIDEO_ID, {
            matchId: target.matchId,
            dryRun: opts.dryRun,
          }).then((o) => (o === "imported" ? ({ outcome: "imported", layout: "starter" } as const) : o));
      if (typeof outcome === "object" && "error" in outcome) {
        errors.push(`end screen ${target.videoId}: ${outcome.error}`);
        continue;
      }
      if (outcome === "already-has-endscreen") {
        await markEndScreenDone(target.videoId, target.matchId);
      } else if (typeof outcome === "object" && outcome.outcome === "imported" && !opts.dryRun) {
        await markEndScreenDone(target.videoId, target.matchId, outcome.layout);
        endScreensAdded++;
      } else if (outcome === "picker-empty") {
        // The picker's own confirmed account-scoping bug (7 Oct 2026) is left unmarked as
        // "done" on purpose — not done, and worth trying again a future cycle rather than
        // permanently. `markPickerEmptySeen` only bounds the retry to once a UTC day
        // (`planCycle`'s own filter) instead of every ~20 min cycle, and `endScreenPickerEmpty`
        // below makes the standing bug visible on the heartbeat rather than indistinguishable
        // from "nothing to do" (fixed 8 Oct 2026 — see WorkerHeartbeat.lastCycle's own comment).
        if (!opts.dryRun) await markPickerEmptySeen(target.videoId);
        endScreenPickerEmpty++;
      } else if (outcome === "no-editor") {
        // A video gone from the channel (Edj_-c7lK38, 14 Oct 2026: a sameErrorStreak of 6 and a
        // false "Needs you") is a state of the record, not a failure — skipped for the day, as pins are.
        console.error(`studio worker: end screen ${target.videoId} skipped today — no editor on its page`);
        endScreenSkippedOn.set(target.videoId, today);
      }
    }

    let tcStarted = 0;
    let tcChecked = 0;
    for (const exp of plan.tcToStart) {
      const video = exp.videos[0];
      if (!video?.videoId) {
        errors.push(`${exp.id}: no videoId on the experiment yet`);
        continue;
      }
      // A test can already be running on the real page — started outside this bookkeeping
      // entirely (a manual `npm run studio -- tc` CLI press before this experiment ever existed,
      // exactly LUI5E7yF0zE's own history, phase 4 8 Oct 2026). Reconcile ground truth rather
      // than ever call startTestAndCompare a second time on it, which Studio refuses anyway (see
      // its own "a test may already be set up" error below).
      const existing = await readTestAndCompare(handle, video.videoId);
      if (!("error" in existing) && existing.state !== "none") {
        await setExperimentChecked(exp.id, existing);
        tcChecked++;
        continue;
      }
      const test = testFor(exp);
      if (!test) {
        errors.push(`${exp.id}: no usable arms`);
        await setNeedsHuman(exp.id, "no usable arms for startTestAndCompare");
        continue;
      }
      const outcome = await startTestAndCompare(handle, video.videoId, test, {
        matchId: video.matchId,
        dryRun: opts.dryRun,
        players: playersFor(exp),
      });
      if (typeof outcome === "object") {
        errors.push(`${exp.id}: ${outcome.error}`);
        await setNeedsHuman(exp.id, outcome.error);
        continue;
      }
      if (!opts.dryRun) {
        await setExperimentRunning(exp.id);
        tcStarted++;
      }
    }

    // A scheduled/private video has no readable A/B result yet (9 Oct 2026: four of the five
    // "could not be read" items were videos still scheduled) — wait until it is public.
    const checkIds = plan.tcToCheck.map((e) => e.videos[0]?.videoId).filter((v): v is string => !!v);
    const checkStats = checkIds.length ? await videoStats(checkIds).catch(() => []) : [];
    for (const exp of plan.tcToCheck) {
      const video = exp.videos[0];
      if (!video?.videoId) continue;
      if (checkStats.find((s) => s.videoId === video.videoId)?.privacyStatus !== "public") continue;
      const read = await readTestAndCompare(handle, video.videoId);
      if ("error" in read) {
        errors.push(`${exp.id}: ${read.error}`);
        await setExperimentReadFailed(exp.id, read.error);
        continue;
      }
      await setExperimentChecked(exp.id, read);
      tcChecked++;
    }

    // New dashboard long-forms get a thumbnail Test & Compare planned for them automatically
    // (phase 4, 8 Oct 2026) — rendering is heavy (ffmpeg SSIM + a Remotion still) but touches no
    // Studio page at all, so it needs no browser session of its own; it rides along in this one
    // only because `runCycle` already has one open. Skipped under `--dry-run`: unlike everything
    // above, there is no "stop right before the last click" point to fall back on here — the
    // render and the `.experiments.json` write are the whole action, so a dry run simply does
    // neither, exactly as `--dry-run` promises elsewhere in this file.
    let thumbnailTestsPlanned = 0;
    if (!opts.dryRun) {
      for (const target of plan.thumbnailTcTargets) {
        const rendered = await renderTcThumbSet(target.matchId);
        if ("error" in rendered) {
          errors.push(`thumbnail tc ${target.videoId}: ${rendered.error}`);
          continue;
        }
        const includeCaption = rendered.caption !== null && rendered.caption.length <= AUTO_CAPTION_MAX_CHARS;
        const files = includeCaption ? rendered.files : rendered.files.slice(0, 2);
        const entry: TcPlanThumbEntry = {
          matchId: target.matchId,
          videoId: target.videoId,
          variants: files,
          approved: true,
        };
        const { added, skipped } = await importTcPlan({ thumbnails: [entry] });
        if (added.length) thumbnailTestsPlanned++;
        for (const s of skipped) errors.push(`thumbnail tc ${s.videoId}: ${s.reason}`);
      }
    }

    // A title Test & Compare, same ride-along reasoning as the thumbnail block above — no
    // browser page touched, just `.experiments.json` (`updateTcExperiments`'s own lock already
    // serializes this against a concurrent `tc-plan`/worker write). Skipped under `--dry-run` for
    // the same reason: the write is the whole action.
    let titleTestsPlanned = 0;
    if (!opts.dryRun) {
      for (const target of plan.titleTcTargets) {
        const id = `tc-title-${target.videoId}`;
        const arms: ExperimentArm[] = [
          { name: "control", settings: { title: target.title }, style: target.controlStyle },
          ...target.challengers.map((c, i) => ({
            name: `challenger${i + 1}`,
            settings: { title: c.title },
            style: c.style,
          })),
        ];
        const exp: Experiment = {
          id,
          kind: "tc",
          variable: "title",
          controlArm: "control",
          arms,
          videos: [{ videoId: target.videoId, matchId: target.matchId, arm: "tc" }],
          status: "planned",
        };
        let added = false;
        await updateTcExperiments((tc) => {
          if (tc.some((e) => e.id === id)) return tc; // another writer beat us to this video
          added = true;
          return [...tc, exp];
        });
        if (added) titleTestsPlanned++;
      }
    }

    // Phase 5, 8 Oct 2026: pin a public long-form's own channel comment, the same `finished.pin`
    // ledger step `finishOnYouTube` uses (off there — `config.studioAutomation` is false, the
    // dashboard has no Chrome) — so the two never both do it, and `pinComment` itself (rail 2)
    // refuses to touch a pin someone already set by hand. `plan.pinTargets` is comment-posted,
    // pin-not-done, uncapped (`pinsThisCycle` caps it after the skips); whether the video is
    // actually public *right now* is re-read live here, exactly the recheck `finishOnYouTube`'s
    // own pin step makes, because the stored `privacyStatus` is from upload time and is never
    // updated — a scheduled upload that only went public after the fact must not sit permanently
    // unpinned for being read as still private.
    let pinsAdded = 0;
    if (plan.pinTargets.length) {
      // videos.list takes at most 50 ids, and `plan.pinTargets` is uncapped.
      const stats = [];
      for (let i = 0; i < plan.pinTargets.length; i += 50)
        stats.push(...(await videoStats(plan.pinTargets.slice(i, i + 50).map((t) => t.videoId))));
      const publicNow = new Set(stats.filter((s) => s.privacyStatus === "public").map((s) => s.videoId));
      // Not public yet is retried a later cycle, not an error.
      const pins = pinsThisCycle(
        plan.pinTargets,
        (id) => publicNow.has(id),
        (id) => pinSkippedOn.get(id) === today,
      );
      for (const target of pins) {
        const outcome = await pinComment(handle, target.videoId, {
          matchId: target.matchId,
          dryRun: opts.dryRun,
        });
        if (typeof outcome === "object") {
          errors.push(`pin ${target.videoId}: ${outcome.error}`);
          continue;
        }
        if (outcome === "pinned" || outcome === "already-pinned") {
          if (!opts.dryRun) {
            await markPinDone(target.matchId);
            pinsAdded++;
          }
        } else {
          // "no-channel-comment" / "skipped-private" are states of the video, not failures: an
          // error here grew the heartbeat's sameErrorStreak into a false "Needs you" item and
          // spent a pin slot on the same video every cycle (8 Oct 2026, gRjV1jG4-Ng).
          // ponytail: in-memory, so a worker restart retries it sooner; persist if that matters.
          console.error(`studio worker: pin ${target.videoId} skipped today — ${outcome}`);
          pinSkippedOn.set(target.videoId, new Date().toISOString().slice(0, 10));
        }
      }
    }

    // Link each Short to its own match's long-form (11 Oct 2026, `plan.relatedLinkTargets`'s own
    // comment covers the filters). "already-linked" marks the ledger done the same as a real
    // "linked" would, since it is a fact true on the server regardless of who set it or when —
    // the same rule `endScreenTargets`' own "already-has-endscreen" branch above already keeps.
    let relatedLinksAdded = 0;
    for (const target of plan.relatedLinkTargets) {
      const outcome = await linkRelatedVideo(handle, target.shortVideoId, target.longFormVideoId, {
        matchId: target.matchId,
        dryRun: opts.dryRun,
      });
      if (typeof outcome === "object") {
        errors.push(`related ${target.shortVideoId}: ${outcome.error}`);
        continue;
      }
      if (outcome === "already-linked") {
        // `linkRelatedVideo` only confirmed the field is non-empty, never that it names this
        // match's own long-form — don't assert an unverified id (silent-failure review, 11 Oct
        // 2026). It still never re-opens the picker for this Short (same rule as `endScreens`).
        await markRelatedLinkDone(target.shortVideoId, target.matchId, null);
      } else if (outcome === "linked" && !opts.dryRun) {
        await markRelatedLinkDone(target.shortVideoId, target.matchId, target.longFormVideoId);
        relatedLinksAdded++;
      } else if ((outcome === "picker-empty" || outcome === "not-found") && !opts.dryRun) {
        await markRelatedRetrySeen(target.shortVideoId);
      }
    }

    // A "WHO TAKES IT?" poll on each long-form public since the last 36 h (22 Oct 2026,
    // `config.communityPolls`, file-only like `endScreenRivalry`). Public is this cycle's own
    // live read — no read, no polls; the DNF check is the API's, per candidate; blocked is the
    // same on-disk check as everything above. `--dry-run` fills the composer and writes nothing.
    let pollsPosted = 0;
    if (communityPollsNow() && live) {
      const candidates: PollCandidate[] = longForms.flatMap((v) => {
        const s = live.get(v.videoId);
        return s
          ? [
              {
                videoId: v.videoId,
                matchId: v.matchId,
                title: v.title ?? "",
                privacyStatus: s.privacyStatus,
                publicAt: s.publishAt ?? s.publishedAt ?? null,
              },
            ]
          : [];
      });
      for (const target of pollTargets(new Date(), candidates, readCommunityPosts(), realIsBlocked)) {
        const record = (outcome: string) => {
          if (!opts.dryRun) recordCommunityPost(target.videoId, target.matchId, outcome);
        };
        if (await matchIsDnf(target.matchId)) {
          record("skipped: DNF");
          continue;
        }
        const poll = pollContentFor(target.title, target.videoId);
        if (!poll) {
          record("skipped: the title names no pair");
          continue;
        }
        const outcome = await postCommunityPoll(handle, poll, { matchId: target.matchId, dryRun: opts.dryRun });
        if (typeof outcome === "object") {
          errors.push(`poll ${target.videoId}: ${outcome.error}`);
          // Post pressed but unseen: terminal, never a second click on the same video.
          record(`${outcome.postClicked ? "unconfirmed" : "error"}: ${outcome.error}`);
          continue;
        }
        record(outcome);
        if (outcome === "posted" && !opts.dryRun) pollsPosted++;
      }
    }

    return {
      probe: probed.result,
      endScreensAdded,
      endScreenPickerEmpty,
      tcStarted,
      tcChecked,
      thumbnailTestsPlanned,
      titleTestsPlanned,
      pinsAdded,
      relatedLinksAdded,
      pollsPosted,
      errors,
    };
  } finally {
    await handle.stop();
  }
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

function jitteredDelayMs(): number {
  return CYCLE_MS + Math.round((Math.random() * 2 - 1) * JITTER_MS);
}

/** 1 for a fresh error, one more than the previous cycle's own streak when it is the exact same
 * message again, 0 when this cycle had none — read-before-write against the heartbeat this same
 * cycle is about to overwrite. */
export async function nextSameErrorStreak(currentError: string | null): Promise<number> {
  if (!currentError) return 0;
  const prev = await readHeartbeat();
  return prev?.lastError === currentError ? (prev.sameErrorStreak ?? 0) + 1 : 1;
}

/** HEAD at the moment this process loaded this module — "the HEAD it started on"
 * (`scripts/studio-worker.sh`'s own supervisor section in CLAUDE.md), the same read-once pattern
 * `src/dashboard/repoHead.ts`'s own `BOOT_HEAD` uses for the dashboard. */
const BOOT_HEAD = repoHead();

/** Pure: true once the live repo HEAD has moved past the one this process started on — null on
 * either side (an unreadable `.git`) never counts as a change, so a repo this can't read for any
 * reason just keeps the worker running on what it already loaded. */
export function newCodeWaiting(bootHead: string | null, liveHead: string | null): boolean {
  return bootHead !== null && liveHead !== null && bootHead !== liveHead;
}

/**
 * Runs cycles forever (or once, with `--once`), human-paced between videos within a cycle
 * (`randomPause` in `studioActions.ts`) and ~20 min ± 3 min between cycles. Never runs inside
 * `inBlackoutWindow` — that cycle is recorded as `"skipped"` and the loop waits for the next one
 * rather than busy-poll the clock. `opts.enable` is this module's own top-of-file comment's gate.
 *
 * Inside that same blackout branch — never mid-cycle, since no browser session is open there —
 * it also checks whether the repo has moved on since this process started
 * (`newCodeWaiting`/`BOOT_HEAD`) and, if so, exits cleanly (code 0) rather than keep looping on
 * stale code: `scripts/studio-worker.sh` restarts the command 60s later, and the new process's
 * own `BOOT_HEAD` then matches, so this fires once per actual change, not every cycle the
 * blackout lasts. `opts.bootHead`/`headNow`/`exit`/`now`/`configFile` are test seams only — every
 * real caller (the CLI) leaves them at their defaults.
 */
export async function runWorker(
  opts: {
    once?: boolean;
    dryRun?: boolean;
    startOpts?: StudioBrowserOptions;
    enable?: boolean;
    bootHead?: string | null;
    headNow?: () => string | null;
    exit?: (code: number) => void;
    now?: () => Date;
    configFile?: string;
  } = {},
): Promise<void> {
  const bootHead = opts.bootHead ?? BOOT_HEAD;
  const headNow = opts.headNow ?? repoHead;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const clock = opts.now ?? (() => new Date());
  for (;;) {
    const now = clock();
    let result: CycleResult;
    const blackout = inBlackoutWindow(now, liveNightlyHour(opts.configFile));
    if (blackout) {
      result = SKIPPED_RESULT;
      if (!opts.once && newCodeWaiting(bootHead, headNow())) {
        console.log(
          `studio worker: new code on disk (${bootHead} -> ${headNow()}) during the blackout — exiting for the supervisor to restart`,
        );
        exit(0);
        return;
      }
    } else {
      try {
        // A runner blocked in the Settings tab since this process started must not get another
        // end screen, pin, test or link; an unreadable file fails the cycle, never runs it stale.
        reloadBlockedPlayers();
        result = await runCycle({ dryRun: opts.dryRun, startOpts: opts.startOpts, enable: opts.enable });
      } catch (err) {
        result = { ...SKIPPED_RESULT, probe: "error", errors: [describeError(err)] };
      }
    }
    const currentError = result.errors[0] ?? null;
    // A blackout cycle never ran, so it carries the last real cycle's error and streak through
    // unchanged: the morning report always lands inside the blackout, and a reset here hid a
    // standing error from its "Needs you" (14 Oct 2026). Branches on `blackout`, not on
    // SKIPPED_RESULT — a disabled gate returns that same object and is a real, clean cycle.
    const prev = blackout ? await readHeartbeat() : null;
    await writeHeartbeat({
      pid: process.pid,
      at: new Date().toISOString(),
      lastCycle: {
        at: now.toISOString(),
        probe: result.probe,
        endScreensAdded: result.endScreensAdded,
        endScreenPickerEmpty: result.endScreenPickerEmpty,
        tcStarted: result.tcStarted,
        tcChecked: result.tcChecked,
        thumbnailTestsPlanned: result.thumbnailTestsPlanned,
        titleTestsPlanned: result.titleTestsPlanned,
        pinsAdded: result.pinsAdded,
        relatedLinksAdded: result.relatedLinksAdded,
        pollsPosted: result.pollsPosted,
      },
      lastError: blackout ? (prev?.lastError ?? null) : currentError,
      lastErrors: blackout ? (prev?.lastErrors ?? []) : result.errors,
      sameErrorStreak: blackout ? (prev?.sameErrorStreak ?? 0) : await nextSameErrorStreak(currentError),
    });
    if (opts.once) return;
    await sleep(jitteredDelayMs());
  }
}
