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

/** `GET /api/shorts/plan/:id`. `PUT /api/shorts/hooks/:id` with `{ titleHook, shortHook }` answers 202 with the same shape; `POST /api/shorts/pick/:id` re-runs the picker. */
export interface ShortPlanResponse {
  matchId: number;
  pick: ShortPick | null;
  /** The saved hooks; null until the operator saves them. */
  shortHook: string | null;
  titleHook: string | null;
  suggestions: { short: string[]; title: string[] };
  state: ShortState;
  /** One line on what is happening, or what failed and what to do about it. */
  detail?: string;
  /** Every problem on the way, newest first, each naming the step it came from — the panel shows them under that step. */
  errors: Array<{ step: "pick" | "render" | "upload-video" | "upload-short"; at: string; message: string }>;
  /** The picked window inside the long-form's own video, for a preview player. */
  preview?: { videoUrl: string; startSec: number; endSec: number };
  uploads: {
    video?: { videoId: string; publishAt?: string };
    short?: { videoId: string; publishAt?: string };
  };
}
