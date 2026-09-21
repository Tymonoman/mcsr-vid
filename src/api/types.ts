// MCSR Ranked API response types, derived from the live OpenAPI spec
// (github.com/MCSR-Ranked/api-docs) and cross-checked against real responses.

export interface UserProfile {
  uuid: string;
  nickname: string;
  roleType: number;
  eloRate: number | null;
  eloRank: number | null;
  country: string | null;
}

export interface RankedCasualStat {
  ranked: number | null;
  casual: number | null;
}

export type StatisticCategoryMap = Record<string, RankedCasualStat>;

export interface UserConnection {
  id: string;
  name: string;
}

export interface Achievement {
  id: string;
  date: number;
  data: string[];
  level: number;
  value: number | null;
  goal: number | null;
}

export interface SeasonStanding {
  eloRate: number;
  eloRank: number | null;
  phasePoint: number;
}

export interface SeasonPhaseResult {
  phase: number;
  eloRate: number;
  eloRank: number;
  point: number;
}

export interface SeasonResultDetailed {
  last: SeasonStanding;
  highest: number;
  lowest: number;
  phases: SeasonPhaseResult[];
}

export interface WeeklyRaceResult {
  id: number;
  time: number;
  rank: number;
}

export interface UserDetails extends UserProfile {
  achievements: {
    display: Achievement[];
    total: Achievement[];
  };
  timestamp: {
    firstOnline: number;
    lastOnline: number;
    lastRanked: number;
    nextDecay: number | null;
  };
  statistics: {
    /** Absent/empty right after a season rollover — pickStats falls back to `total` there. */
    season: StatisticCategoryMap | null;
    total: StatisticCategoryMap;
  };
  connections: Record<string, UserConnection>;
  seasonResult: SeasonResultDetailed | null;
  weeklyRaces: WeeklyRaceResult[];
}

export interface MatchSeed {
  id: string | null;
  overworld: string | null;
  nether: string | null;
  endTowers: number[];
  variations: string[];
}

export interface MatchResult {
  uuid: string | null;
  time: number;
}

export interface MatchRank {
  season: number | null;
  allTime: number | null;
}

export interface MatchChange {
  uuid: string;
  change: number | null;
  eloRate: number | null;
}

export interface MatchVod {
  uuid: string;
  url: string;
  startsAt: number;
}

export interface CompletionEntry {
  uuid: string;
  time: number;
}

export interface TimelineEntry {
  uuid: string;
  time: number;
  type: string;
}

export interface MatchInfo {
  id: number;
  type: number;
  season: number;
  category: string | null;
  gameMode: string | null;
  date: number;
  players: UserProfile[];
  spectators: UserProfile[];
  seed: MatchSeed | null;
  result: MatchResult;
  forfeited: boolean;
  decayed: boolean;
  rank: MatchRank;
  changes: MatchChange[];
  vod: MatchVod[];
  completions: CompletionEntry[];
  timelines: TimelineEntry[];
  tag: string | null;
  replayExist: boolean;
  beginner: boolean;
  botSource: string | null;
  seedType: string | null;
  bastionType: string | null;
}

/**
 * An entry from the `/matches` list endpoint. It carries everything `MatchInfo` does
 * *except* `timelines` and `completions` — fetch the match by id (`getMatch`) when you
 * need those. Splitting the type keeps a feed entry from being handed to code that
 * expects a timeline, which would silently score every match as having no splits.
 */
export type FeedMatch = Omit<MatchInfo, "timelines" | "completions">;

/** A seeded entrant of a playoff bracket (`/playoffs`). `seasonEloRate` is the frozen season-end rating. */
export interface PlayoffPlayer {
  uuid: string;
  nickname: string;
  seasonEloRate: number;
  seasonEloRank: number;
  /** 0-based; 12 and up came through the last-chance qualifier. */
  seedNumber: number;
  personalBest: number;
}

/** One slot of the bracket — a whole best-of series, not a game. */
export interface PlayoffSlot {
  id: number;
  name: string;
  nextMatchId: number | null;
  /** Wins needed: 3 for a Bo5, 4 for a Bo7. */
  maxRoundScore: number;
  /** Epoch seconds, or null until scheduled. */
  startTime: number | null;
  state: string | null;
  /** `player` indexes `PlayoffBracket.players`. `roundScore` is the score *now* — never shown. */
  participants: { player: number; roundScore: number }[];
  vod: string | null;
}

export interface PlayoffBracket {
  season: number;
  players: PlayoffPlayer[];
  matches: PlayoffSlot[];
  results: { player: number | null; place: number; prize: number }[];
}

export interface VersusResultMap {
  total: number;
  [uuid: string]: number;
}

export interface VersusStats {
  players: UserProfile[];
  results: {
    ranked: VersusResultMap;
    casual: VersusResultMap;
  };
  changes: Record<string, number>;
}
