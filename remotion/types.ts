/** Which bucket the form stats (avg/games/WR/FF) were taken from — shown on the overlay so the
 *  numbers can't be misread as career totals (or as season stats) the way they were before. */
export type StatsScope = "SEASON" | "CAREER";

export interface PlayerIdentity {
  nickname: string;
  countryFlag: string;
  /** Rating carried *into* this match, not the player's rating now. See eloAtMatchStart. */
  eloRate: number;
  /** Render-time world rank; null when unranked or between seasons, and then simply not shown. */
  eloRank: number | null;
  statsScope: StatsScope;
  /** Lifetime best, even when statsScope is SEASON — "PB" means all-time in speedrunning. */
  pbMs: number;
  avgMs: number;
  gamesPlayed: number;
  winRatePct: number;
  forfeitRatePct: number;
  avatarUrl: string;
  /** Small isometric head render (NMSR `/head/{uuid}`) for the chat-heads-style icon next to the nickname. */
  headUrl: string;
  achievements: { id: string; level: number }[];
}

export interface SplitRow {
  label: string;
  /** null means this player never reached this checkpoint (DNF at this split). */
  leftMs: number | null;
  rightMs: number | null;
}

export type OverlayProps = {
  left: PlayerIdentity;
  right: PlayerIdentity;
  matchPlayedLabel: string;
  h2hLeftWins: number;
  h2hRightWins: number;
  splits: SplitRow[];
  /** Frame at which the RTA timer starts counting from 0 (the synced match-start frame). */
  timerStartFrame: number;
  /** Final completion ms; the live timer counts up to this and holds. null = keep counting/DNF. */
  runResultMs: number | null;
  /** Overworld structure near spawn, e.g. "DESERT_TEMPLE". null if unknown. */
  seedType: string | null;
  /** Bastion remnant type, e.g. "STABLES". null if unknown. */
  bastionType: string | null;
  /** Total length of this render, in frames at the composition's fps — matches the synced clip length. */
  durationInFrames: number;
  /** Overlay render frame rate; independent of the 60fps footage it's composited over. */
  fps: number;
};

export interface ThumbnailPlayer {
  nickname: string;
  eloRate: number;
  /** Pre-resolved full-body render image (Starlight Skins pose render, falls back to a static renderer). */
  avatarUrl: string;
}

export type ThumbnailProps = {
  left: ThumbnailPlayer;
  right: ThumbnailPlayer;
  /** Top category bar text, e.g. "MINECRAFT · SPEEDRUNNING · RANKED". */
  headerLabel: string;
};

/** One player as a Shorts nameplate shows them. */
// `type`, not `interface`, and deliberately: Remotion's Composition generic requires props to
// be assignable to Record<string, unknown>, which a type alias satisfies through its implicit
// index signature and an interface does not. OverlayProps above is a type alias for the same
// reason.
export type ShortPlayer = {
  nickname: string;
  eloRate: number;
  eloRank: number | null;
};

export type ShortProps = {
  top: ShortPlayer;
  bottom: ShortPlayer;
  /** The line that has to earn the scroll, on screen for the first few seconds. */
  hook: string;
  /** RTA at the Short's first frame, so the running timer stays true to the match. */
  timerStartMs: number;
  durationInFrames: number;
  fps: number;
};
