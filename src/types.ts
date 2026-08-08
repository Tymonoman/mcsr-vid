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
    season: StatisticCategoryMap;
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
