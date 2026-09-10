import path from "node:path";
import { matchDir } from "./config.js";

/** The format half every upload shares, matching the titles already on the channel. */
const FORMAT_SUFFIX = "MCSR Ranked 1v1";
export const SEPARATOR = " | ";
/** Stands in for the editorial hook, which is the one part worth writing by hand. */
export const HOOK_PLACEHOLDER = "<HOOK>";

// Two limits pull against each other. Titles of 70-100 characters outperform shorter ones by
// 10-14%, so the hook needs length; but YouTube truncates around 50 characters on mobile, and the
// player nicknames are the actual search terms in this niche, so they have to land before the
// cut. The hook budget below is just the overlap between those two.
const TARGET_MIN = 70;
const HARD_MAX = 100;
const MOBILE_CUTOFF = 50;

export interface TitleInput {
  leftNickname: string;
  rightNickname: string;
  /** Replaces the format suffix — a playoff game's round and game number (src/playoffs.ts). */
  suffix?: string;
}

export interface BuiltTitle {
  /** The full line, hook still a placeholder. */
  title: string;
  /** The part derived from the API — nicknames and format label, never retyped by hand. */
  generated: string;
  /** Hook length that brings the whole title up to TARGET_MIN. 0 if it is already there. */
  hookMin: number;
  /** Longest hook that stays under HARD_MAX and keeps both names inside MOBILE_CUTOFF. */
  hookMax: number;
}

/**
 * Builds the half of a video title that can be derived from the match: both nicknames, spelled
 * the way the API spells them, plus the shared format suffix. Nicknames are the highest-value
 * search terms here, and a misspelt one is invisible.
 *
 * The hook is left as a placeholder, because that judgement is not derivable.
 */
export function buildTitle({ leftNickname, rightNickname, suffix = FORMAT_SUFFIX }: TitleInput): BuiltTitle {
  const generated = `${leftNickname} vs ${rightNickname}${SEPARATOR}${suffix}`;
  const hookMax = Math.max(
    0,
    Math.min(MOBILE_CUTOFF - SEPARATOR.length, HARD_MAX - SEPARATOR.length - generated.length),
  );
  // With short nicknames there is no hook that satisfies both limits; keeping the names findable
  // on mobile beats padding to 70 characters, so the mobile cutoff wins.
  const hookMin = Math.min(Math.max(0, TARGET_MIN - SEPARATOR.length - generated.length), hookMax);

  return {
    title: `${HOOK_PLACEHOLDER}${SEPARATOR}${generated}`,
    generated,
    hookMin,
    hookMax,
  };
}

/**
 * The same title with a hook already in it, or unchanged when there is none worth putting there.
 *
 * A hook over budget is left as the placeholder rather than cut to fit: the budget is what keeps
 * both nicknames inside YouTube's mobile cutoff, and a silently truncated hook stops mid-word on
 * the one line that has to earn the click. Rejecting it puts the decision back where it belongs.
 */
export function withHook(built: BuiltTitle, hook: string | null | undefined): BuiltTitle {
  const text = hook?.trim() ?? "";
  if (text === "" || text.length > built.hookMax) return built;
  return { ...built, title: `${text}${SEPARATOR}${built.generated}` };
}

/** Renders the paste-and-edit file: the title on its own first line, then how to finish it. */
export function formatTitle(built: BuiltTitle): string {
  // Length of everything but the hook, so the guidance can show what the budget actually buys —
  // the 70-100 band is the target, and a bare character count doesn't say whether you hit it.
  // Derived from `generated` rather than from the title's length, which no longer implies a
  // placeholder: `withHook` may already have filled it in.
  const base = SEPARATOR.length + built.generated.length;
  const filled = !built.title.includes(HOOK_PLACEHOLDER);
  return [
    built.title,
    "",
    // A zero budget is not "write a zero-character hook": it means the derived half alone has
    // reached the ceiling, which a playoff suffix plus two long nicknames does. Say that, or the
    // instruction reads as an impossible one.
    built.hookMax === 0
      ? `No room for a hook: the line above is already ${base} characters without one, ` +
        `against a ${HARD_MAX}-character ceiling. Drop the ${HOOK_PLACEHOLDER} and the separator.`
      : (filled
          ? `The hook is the pipeline's own first suggestion — replace it`
          : `Replace ${HOOK_PLACEHOLDER}`) +
        ` with ${built.hookMin}-${built.hookMax} characters ` +
        `(title lands at ${base + built.hookMin}-${base + built.hookMax}).`,
    `Both nicknames come from the API — don't retype them.`,
  ].join("\n");
}

/**
 * Where a match's title and description live. Generated text is regenerable and the pipeline
 * rewrites it on every run, so edits go to a `.edited.txt` sibling rather than over the top, and
 * every reader prefers the edit.
 *
 * Here rather than in the dashboard because four things read it — the title editor, the publish
 * checklist, the publish kit and the upload (src/youtubeStore.ts `uploadTextFor`) — and a fourth
 * copy of "the edit wins" is a fourth chance for the upload to send yesterday's title.
 */
export function metaPaths(matchId: number, kind: "title" | "description") {
  const base = path.join(matchDir(matchId), `match-${matchId}.${kind}`);
  return { generated: `${base}.txt`, edited: `${base}.edited.txt` };
}
