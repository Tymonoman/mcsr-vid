/**
 * The Short pipeline's shared contract (23 Sept 2026): what the picker writes, what the render
 * takes besides the clips, and what the dashboard's Short panel reads.
 *
 * The operator's rules this encodes: a model watches the whole match and picks the moment —
 * one continuous window, both POVs or one player's alone, its length set by the moment; nothing
 * renders a Short until the operator has confirmed its hook, and nothing uploads (long-form or
 * Short) until the hooks are saved; after that the render and both uploads run by themselves.
 */
import path from "node:path";

/** Bounds on a Short's length. The picker chooses inside them; the length follows the moment. */
export const SHORT_MIN_MS = 12_000;
export const SHORT_MAX_MS = 60_000;

/** What the picker chose. Written to `short-<id>.pick.json` in the match's directory (game 1's for a series). */
export interface ShortPick {
  /** The game whose footage the window is in: the match itself, or one game of a series. */
  gameMatchId: number;
  /** The window, in ms of that game's match clock (RTA 0:00 = match start). */
  startMs: number;
  endMs: number;
  /** Which POVs the Short shows: both stacked, or one player's alone. `left` is `match.players[0]`. */
  pov: "both" | "left" | "right";
  /** With both POVs, whose audio leads (the other is lowered 12 dB). Absent: both at one level. */
  focus?: "left" | "right";
  /** The picker's proposal for the Short's hook. A suggestion only: the operator confirms it. */
  hookSuggestion: string;
  /** One line for the operator's panel, never published. */
  why: string;
  /** A single play (a death, a zero, a clutch) or a race arc (a chase, a near tie). */
  kind: "play" | "race";
  source: "agy" | "heuristic";
  model?: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /**
   * The model's proposals for the long-form's title hook, in the style of the operator's past
   * ones (24 Sept 2026). Each passed `hookProblem`; suggestions only. Absent on a heuristic pick.
   */
  titleHooks?: string[];
  /** One moment per player the model would send that player (the publish kit's DM). */
  playerMoments?: { left?: PlayerMoment; right?: PlayerMoment };
}

/** A player's moment: `atMs` on the match clock of its game — `gameMatchId` for a series, else the match. */
export interface PlayerMoment {
  atMs: number;
  line: string;
  gameMatchId?: number;
}

/** A caption built from the race data, on screen from `atMs` (ms into the Short) until the next one. */
export interface ShortCaption {
  atMs: number;
  text: string;
  /** Whose colour it takes; null for a neutral line. */
  side: "left" | "right" | null;
}

export const pickFile = (matchDir: string, matchId: number): string =>
  path.join(matchDir, `short-${matchId}.pick.json`);

/** The operator-confirmed Short hook. Only the dashboard's hooks route writes it. */
export const shortHookFile = (matchDir: string, matchId: number): string =>
  path.join(matchDir, `short-${matchId}.hook.txt`);

/** Where a match stands on its way to the channel, as the Short panel and the list show it. */
export type ShortState =
  | "no-export" // the long-form is not exported yet
  | "picking" // the model is watching the match
  | "waiting-for-hook" // a pick exists (or the picker failed and the heuristic stands in); the operator has not saved the hooks
  | "rendering" // the hooks are saved and the Short is being cut
  | "uploading"
  | "scheduled" // both videos are on the channel, private, with a publish time
  | "published"
  | "failed";

/**
 * `PUT /api/shorts/hooks/:id`. `noShort: true` with `shortHook: null` is "this match gets no
 * Short": the long-form still goes out once its title hook is saved.
 */
export interface SaveHooksRequest {
  titleHook: string;
  shortHook: string | null;
  noShort?: boolean;
}

/** What `GET /api/matches` adds to each row, for the list's state line and its order. */
export interface MatchRowShort {
  shortState: ShortState;
  /** e.g. "Short 6:21–7:02, 41 s, both" or "model failed, heuristic pick". */
  shortDetail?: string;
}

/** A step running right now: the panel's live status line ("asking Gemini 3.8 Flash · 1:10"). */
export interface ShortActivity {
  step: "pick" | "render" | "upload-video" | "upload-short";
  /** What it is doing now, in the operator's words: "running /watch on silverrruns' stream". */
  line: string;
  /** ISO 8601 UTC: when this line started, for the elapsed time. */
  since: string;
  percent?: number;
}

/** One line of `short-<id>.log.jsonl`: every stage of the pick, the render and the uploads writes here. */
export interface ShortLogLine {
  at: string;
  step: "pick" | "render" | "upload-video" | "upload-short" | "chain";
  level: "info" | "warn" | "error";
  text: string;
  /** Long material for the Details fold: the model's raw answer, a validation reason, a command's stderr tail. */
  detail?: string;
}

/** What `GET /api/nightly` adds, for the strip's "3 waiting for a hook ›" and "1 failed ›". */
export interface NightlyShortSummary {
  waitingForHook: number[];
  failed: number[];
  /** The picker's health across the box: `ok: false` when the model cannot be reached at all (e.g. not signed in). */
  picker: { ok: boolean; message?: string };
  /** The strip's Activity line: what the box is doing now and what waits its turn. */
  activity: { running: Array<{ matchId: number } & ShortActivity>; queued: number[] };
}

/** `GET /api/shorts/plan/:id`. `PUT /api/shorts/hooks/:id` (a `SaveHooksRequest`) answers 202 with the same shape; `POST /api/shorts/pick/:id` re-runs the picker. */
export interface ShortPlanResponse {
  matchId: number;
  pick: ShortPick | null;
  /** The picker's queue for this match: waiting its turn, or watching the video now. */
  pickActivity?: "queued" | "running";
  /** The saved hooks; null until the operator saves them. */
  shortHook: string | null;
  titleHook: string | null;
  /** The operator chose no Short for this match. */
  noShort?: boolean;
  /** The sync detector was not sure: the panel opens the sync frames and the save button says so. */
  syncWeak?: boolean;
  suggestions: { short: string[]; title: string[] };
  state: ShortState;
  /** One line on what is happening, or what failed and what to do about it. */
  detail?: string;
  /** Every problem on the way, newest first, each naming the step it came from — the panel shows them under that step. */
  errors: Array<{ step: "pick" | "render" | "upload-video" | "upload-short"; at: string; message: string }>;
  /** The step running now, if any. */
  activity?: ShortActivity;
  /** The last lines of `short-<id>.log.jsonl`, newest last (at most 60). */
  log: ShortLogLine[];
  /** The picked window inside the long-form's own video, for a preview player. */
  preview?: { videoUrl: string; startSec: number; endSec: number };
  uploads: {
    video?: { videoId: string; publishAt?: string };
    short?: { videoId: string; publishAt?: string };
  };
}
