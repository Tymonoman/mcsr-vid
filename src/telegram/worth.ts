/**
 * "Worth rendering today": ranked matches from the last three days between players people know,
 * that nobody has rendered and whose two Twitch VODs can be found, scored by how close and how
 * eventful the run was — the morning report's answer to "what goes in tonight's render?" (the
 * operator's night goal, 30 Sept 2026: "don't render the Jabo_ vs sub5average those are no name
 * players no one will click on that").
 *
 * What a gather costs: one MCSR list call per roster player, one match call per scored candidate
 * (at most `MAX_SCORED`), no profile calls — Twitch logins and follower counts come from the
 * dashboard scans' cache (`scanKnowledge`) — and, only when fewer than `MAX_SCORED` matches have
 * both VODs attached, a `yt-dlp` archive listing per channel of a match one VOD short (Twitch's
 * budget, not the MCSR API's). `gatherWorth` keeps the answer six hours in the state file, so a
 * second report spends nothing.
 */
import { getMatch, getUserMatches } from "../api/mcsrApi.js";
import { blockedIn, config } from "../config.js";
import type { FeedMatch, MatchInfo, MatchVod, UserDetails } from "../api/types.js";
import { hiddenMatchIds } from "../dashboard/matchShelf.js";
import { listProcessedMatchIds } from "../dashboard/matchStatus.js";
import { knownPlayerFor, scanKnowledge } from "../dashboard/suggest.js";
import { describeError } from "../errorText.js";
import { computeMetrics, type MatchMetrics } from "../pipeline/matchScore.js";
import { discoverVods, listArchivesWithYtDlp } from "../pipeline/vodDiscovery.js";
import { readTelegramState, updateTelegramState } from "./state.js";

/** The channel's own players, whose last three days of ranked matches are read. */
export const WATCH_ROSTER: readonly string[] = [
  "doogile",
  "Feinberg",
  "Infume",
  "Pinne",
  "lowk3y_",
  "silverrruns",
];

/** How far back a match still counts as news. */
const WINDOW_DAYS = 3;
/** A run under six minutes is a forfeit or a reset, not a match (the night's search used the same floor). */
const MIN_RUN_MS = 6 * 60_000;
/**
 * Candidates whose match is fetched for its timeline, one MCSR call each. ponytail: the first eight
 * by name and recency, not by story — a thrilling ninth goes unseen; raise it when the API budget allows.
 */
export const MAX_SCORED = 8;
/** The newest archives asked of each channel: a match from the last three days is among its first few. */
const ARCHIVES_LISTED = 10;
const CONCURRENCY = 4;
export const WORTH_TTL_MS = 6 * 3_600_000;

export interface WorthMatch {
  matchId: number;
  /** `<left> vs <right>`, the API's spelling. */
  players: string;
  /** ISO 8601 UTC, when the match ended. */
  playedAt: string;
  runMs: number;
  /** One line that names nobody: lead changes, deaths, how close the finish was. */
  story: string;
  /** 0–1, `worthInterest` — the order of the list. */
  score: number;
}

export interface WorthFacts {
  /** Best first, at most `MAX_SCORED`. */
  matches: WorthMatch[];
  /** What could not be read or looked up, so an empty list is not mistaken for a quiet three days. */
  notes: string[];
}

/** Everything the gather touches outside itself, so the tests can run it without a network. */
export interface WorthDeps {
  roster: readonly string[];
  listMatches: (nickname: string) => Promise<FeedMatch[]>;
  fetchMatch: (matchId: number) => Promise<MatchInfo>;
  /** The VODs discovery finds for the players `match.vod` lacks; [] when it finds none. */
  discover: (match: FeedMatch) => Promise<MatchVod[]>;
  /** A player people know: on the roster, or enough followers. */
  isKnown: (nickname: string) => boolean;
  /** On disk, hidden on the dashboard or dismissed from its suggestions. */
  isTaken: (matchId: number) => boolean;
  /** Lookup problems; the live `discover` appends as a channel fails to list. */
  notes: string[];
}

const onRoster = (roster: readonly string[], nickname: string): boolean =>
  roster.some((r) => r.toLowerCase() === nickname.toLowerCase());

/**
 * The matches worth looking further at: two players who are both names, a real finished run in the
 * window, not already taken — roster pairs first, then newest. A match reads the same in both
 * players' lists, so it is counted once.
 */
export function worthCandidates(
  feed: Iterable<FeedMatch>,
  nowMs: number,
  d: Pick<WorthDeps, "roster" | "isKnown" | "isTaken">,
): FeedMatch[] {
  const cutoffSec = nowMs / 1000 - WINDOW_DAYS * 86_400;
  const unique = new Map<number, FeedMatch>();
  for (const m of feed) unique.set(m.id, m);
  const rosterSeats = (m: FeedMatch) => m.players.filter((p) => onRoster(d.roster, p.nickname)).length;
  return [...unique.values()]
    .filter(
      (m) =>
        m.date >= cutoffSec &&
        m.players.length === 2 &&
        !m.forfeited &&
        m.result.uuid !== null &&
        m.result.time >= MIN_RUN_MS &&
        !d.isTaken(m.id) &&
        m.players.every((p) => d.isKnown(p.nickname)) &&
        !blockedIn(m.players.map((p) => p.nickname)),
    )
    .sort((a, b) => rosterSeats(b) - rosterSeats(a) || b.date - a.date);
}

const secs = (ms: number): string => (ms / 1000).toFixed(1);

/**
 * How close the race was at its last comparable point: the finish when both runners killed the
 * dragon (`at` null), else the last split both reached.
 */
function finishGap(m: MatchMetrics): { ms: number; at: string | null } | null {
  if (m.finishMarginMs !== null) return { ms: m.finishMarginMs, at: null };
  const last = [...m.splits].reverse().find((s) => s.gapMs !== null);
  return last ? { ms: last.gapMs!, at: last.label } : null;
}

/** "lead changes 3x, 1 death, 0.2 s apart at Stronghold" — facts from the timelines, nobody named. */
export function worthStory(m: MatchMetrics): string {
  const parts = [
    m.leadChanges === 0
      ? "no lead change"
      : m.leadChanges === 1
        ? "lead changes once"
        : `lead changes ${m.leadChanges}x`,
  ];
  if (m.deaths > 0) parts.push(`${m.deaths} death${m.deaths === 1 ? "" : "s"}`);
  const gap = finishGap(m);
  if (gap)
    parts.push(gap.at === null ? `finish ${secs(gap.ms)} s apart` : `${secs(gap.ms)} s apart at ${gap.at}`);
  return parts.join(", ");
}

/** How much a gap at each split says about the finish; any earlier split says little. */
const STAGE_WEIGHT: Record<string, number> = { "End enter": 0.85, Stronghold: 0.5, "Blind travel": 0.3 };

/**
 * 0–1, the order of the list: half how close the race was (a gap counts for more the later in the
 * run it was, and 30 s apart at the finish is as dull as 60 s apart at a split), 0.3 lead changes
 * (three is the most), 0.2 real deaths. The night's search of 30 Sept 2026 ranked its 34 candidates
 * with this same formula (forfeits aside, which are not candidates here).
 */
export function worthInterest(m: MatchMetrics): number {
  const gap = finishGap(m);
  const stage = gap === null ? 0 : gap.at === null ? 1 : (STAGE_WEIGHT[gap.at] ?? 0.15);
  const close = gap === null ? 0 : stage * Math.max(0, 1 - gap.ms / (gap.at === null ? 30_000 : 60_000));
  return 0.5 * close + 0.3 * (Math.min(m.leadChanges, 3) / 3) + 0.2 * (Math.min(m.deaths, 3) / 3);
}

/** One scored match. */
export function worthEntry(match: MatchInfo): WorthMatch {
  const metrics = computeMetrics(match);
  return {
    matchId: match.id,
    players: metrics.players.join(" vs "),
    playedAt: new Date(match.date * 1000).toISOString(),
    runMs: match.result.time,
    story: worthStory(metrics),
    score: Math.round(worthInterest(metrics) * 100) / 100,
  };
}

/** `fn` over `items`, `CONCURRENCY` at a time, results in the items' order. */
async function inPool<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const vodOf = (m: FeedMatch, uuid: string): boolean => m.vod.some((v) => v.uuid === uuid);

/**
 * The gather itself: roster lists → candidates → the ones with both VODs → the first `MAX_SCORED`
 * fetched and scored. A list that cannot be read costs that player's matches and a note; all of
 * them failing is an error, not an empty answer.
 */
export async function findWorth(nowMs: number, d: WorthDeps): Promise<WorthFacts> {
  const notes: string[] = [];
  const lists = await Promise.allSettled(d.roster.map((nickname) => d.listMatches(nickname)));
  const feed: FeedMatch[] = [];
  lists.forEach((list, i) => {
    if (list.status === "fulfilled") feed.push(...list.value);
    else notes.push(`${d.roster[i]}'s matches could not be read (${describeError(list.reason)})`);
  });
  const firstFailure = lists.find((l): l is PromiseRejectedResult => l.status === "rejected");
  if (firstFailure && notes.length === d.roster.length) throw firstFailure.reason;

  const candidates = worthCandidates(feed, nowMs, d);
  // The players attach their own VODs, and nearly always both or neither: on 30 Sept 2026 the
  // pipeline's discovery found one VOD in ~120 lookups, ~25 s of yt-dlp apiece. So an attached pair
  // is ready as it stands, and discovery only tries to fill the slots those leave empty, for the
  // matches one VOD short.
  const hasBoth = (m: FeedMatch) => m.players.every((p) => vodOf(m, p.uuid));
  const ready = new Set(candidates.filter(hasBoth));
  const oneShort = candidates
    .filter((m) => m.players.filter((p) => !vodOf(m, p.uuid)).length === 1)
    .slice(0, Math.max(0, MAX_SCORED - ready.size));
  for (const m of await inPool(oneShort, async (m) => ((await d.discover(m)).length > 0 ? m : null)))
    if (m) ready.add(m);
  const scored = await inPool(candidates.filter((m) => ready.has(m)).slice(0, MAX_SCORED), async (m) => {
    try {
      return worthEntry(await d.fetchMatch(m.id));
    } catch (err) {
      notes.push(`#${m.id} could not be read (${describeError(err)})`);
      return null;
    }
  });
  const matches = scored
    .filter((w): w is WorthMatch => w !== null)
    .sort((a, b) => b.score - a.score || b.playedAt.localeCompare(a.playedAt));
  return { matches, notes: [...notes, ...d.notes] };
}

/** Already on disk, hidden on the dashboard or dismissed from its suggestions — read fresh on every call. */
export function takenNow(
  dismissed: ReadonlySet<number> = scanKnowledge().dismissed,
): (matchId: number) => boolean {
  const processed = new Set(listProcessedMatchIds());
  const hidden = hiddenMatchIds();
  return (id) => processed.has(id) || hidden.has(id) || dismissed.has(id);
}

/**
 * The real thing: MCSR lists and matches, the scans' cache for Twitch logins and followers,
 * yt-dlp for archives (one listing per channel, asked once however many matches need it).
 * ponytail: a player the cache has no login for, and no attached VOD, cannot be looked up without
 * a profile call per player — such a match is left out rather than spend the API budget on it.
 */
export function liveDeps(): WorthDeps {
  const known = scanKnowledge();
  const notes: string[] = [];
  const listings = new Map<string, Promise<string>>();
  const listing = (login: string): Promise<string> => {
    let p = listings.get(login);
    if (!p) {
      p = listArchivesWithYtDlp(login, ARCHIVES_LISTED);
      p.catch((err: unknown) => {
        console.error(`telegram: worth: twitch.tv/${login} could not be listed — ${describeError(err)}`);
        notes.push(`twitch.tv/${login} could not be listed`);
      });
      listings.set(login, p);
    }
    return p;
  };
  return {
    // The Settings tab's roster; the constant stands in when the operator empties the list.
    roster: config.favouritePlayers.length ? config.favouritePlayers : WATCH_ROSTER,
    notes,
    listMatches: (nickname) => getUserMatches(nickname, { type: 2, count: 100 }),
    fetchMatch: getMatch,
    isTaken: takenNow(known.dismissed),
    // One definition of "known" (suggest.ts's knownTierFor/knownPlayerFor share it), not two: a
    // favourite, or — for anyone else — a measured draw when one exists, else Twitch followers.
    isKnown: knownPlayerFor(
      config.favouritePlayers.length ? config.favouritePlayers : WATCH_ROSTER,
      (nickname) => known.twitchOf(nickname)?.followers ?? null,
      config.knownFollowerThreshold,
    ),
    discover: (match) => {
      const loginOf = new Map(match.players.map((p) => [p.uuid, known.twitchOf(p.nickname)?.login]));
      return discoverVods(
        { ...match, timelines: [], completions: [] },
        {
          getUser: async (uuid) => {
            const login = loginOf.get(uuid);
            return { connections: login ? { twitch: { id: login, name: login } } : {} } as UserDetails;
          },
          listArchives: listing,
          log: () => {},
        },
      );
    },
  };
}

/**
 * The section as the report reads it. Within `WORTH_TTL_MS` of the last gather the state
 * file's copy is used (minus anything taken since); `fresh` — the `/worth` command — gathers anew.
 * Whatever a gather found is kept, notes included: they are shown with it, and a dead Twitch login
 * would otherwise cost 14 calls and a yt-dlp round on every report. A gather that throws is not
 * kept. Under `--dry-run` the state write is skipped (state.ts).
 */
export async function gatherWorth(
  nowMs: number,
  opts: { fresh?: boolean } = {},
  deps?: WorthDeps,
): Promise<WorthFacts> {
  const cached = readTelegramState().worth;
  if (!opts.fresh && cached && cached.at <= nowMs && nowMs - cached.at < WORTH_TTL_MS) {
    const taken = deps?.isTaken ?? takenNow();
    return { ...cached.data, matches: cached.data.matches.filter((m) => !taken(m.matchId)) };
  }
  const facts = await findWorth(nowMs, deps ?? liveDeps());
  updateTelegramState((s) => {
    s.worth = { at: nowMs, data: facts };
  });
  return facts;
}
