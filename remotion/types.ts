export interface PlayerIdentity {
  nickname: string;
  countryFlag: string;
  eloRate: number;
  eloRank: number;
  pbMs: number;
  avgMs: number;
  gamesPlayed: number;
  winRatePct: number;
  forfeitRatePct: number;
  avatarUrl: string;
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
