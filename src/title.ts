/** The format half every upload shares, matching the titles already on the channel. */
const FORMAT_SUFFIX = "MCSR Ranked 1v1";
const SEPARATOR = " | ";
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
 * the way the API spells them, plus the shared format suffix. Two published titles misspelled a
 * player ("Fineberg" for Feinberg, "silverruns" for silverrruns) because that half was retyped by
 * hand while the description generator had it right all along — nicknames are the highest-value
 * search terms here, and a misspelt one is simply invisible.
 *
 * The hook is deliberately left as a placeholder. "YN vs TAS" is why one upload got 3,654 views
 * and its neighbours got 53-298; that judgement is not something this can make.
 */
export function buildTitle({ leftNickname, rightNickname }: TitleInput): BuiltTitle {
  const generated = `${leftNickname} vs ${rightNickname}${SEPARATOR}${FORMAT_SUFFIX}`;
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

/** Renders the paste-and-edit file: the title on its own first line, then how to finish it. */
export function formatTitle(built: BuiltTitle): string {
  // Length of everything but the hook, so the guidance can show what the budget actually buys —
  // the 70-100 band is the target, and a bare character count doesn't say whether you hit it.
  const base = built.title.length - HOOK_PLACEHOLDER.length;
  return [
    built.title,
    "",
    `Replace ${HOOK_PLACEHOLDER} with ${built.hookMin}-${built.hookMax} characters ` +
      `(title lands at ${base + built.hookMin}-${base + built.hookMax}).`,
    `Both nicknames come from the API — don't retype them.`,
  ].join("\n");
}
