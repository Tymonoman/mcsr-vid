/**
 * Creator watch: idea 2 of the YPP growth plan (11 Oct 2026). Every subscriber burst at the
 * rival replay channels followed an outside creator's MCSR moment — Ludwig's arc, Dec 2025 to
 * Feb 2026 — and this channel's Suggested traffic gets 0% from a bigger channel. When a watched
 * creator's account plays a ranked match this channel can render, get it in front of tonight's
 * queue before the moment cools.
 *
 * `config.creatorWatchlist` names the accounts (MCSR Ranked nicknames); `config.creatorWatch`
 * (off by default) turns the tick on. Both start empty/off — see CLAUDE.md's Dashboard section
 * for which outside creators were actually verified to have ranked-match activity, with dates.
 *
 * Cost per 15-minute tick: one `getUserMatches` list call per watched name not checked in the
 * last `CHECK_INTERVAL_MS` (in the steady state, every name every tick), plus — only for a match
 * genuinely new to the watch — one `getMatch` and the pipeline's own VOD discovery
 * (`withDiscoveredVods`), the same calls `nightly.ts`'s `playoffVodsReady` already spends on a
 * playoff candidate. A match is resolved (queued, or recorded with why not) exactly once, ever:
 * `state.hits` is both the morning report's source and the "already looked at this one" memory,
 * so a persistent miss (no Twitch VOD, the night's one slot already taken) costs nothing on a
 * later tick rather than re-running VOD discovery on it forever.
 */
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getMatch, getUserMatches } from "../api/mcsrApi.js";
import type { FeedMatch } from "../api/types.js";
import { isDnf } from "../pipeline/matchScore.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";
import { hiddenMatchIds, nightlyQueue, setNightlyQueue } from "./matchShelf.js";
import { listProcessedMatchIds } from "./matchStatus.js";

/** `type` 2 is ranked (`RecentMatchQuery`'s own comment) — the only kind this feature watches. */
const RANKED_TYPE = 2;
/** "A few most recent" (the task's own words): enough to not miss one between ticks, no more. */
const RECENT_COUNT = 3;
/** "Skip a name checked < 15 min ago" — the same cadence as the tick that calls this. */
export const CHECK_INTERVAL_MS = 15 * 60_000;
/** Bounds `.creator-watch.json`'s growth; hits are rare, so this is never expected to bite. */
const MAX_STORED_HITS = 200;

export interface CreatorWatchHit {
  matchId: number;
  /** The watchlist entry this came from, API spelling. */
  nick: string;
  /** "<left> vs <right>", the API's spelling — `WorthMatch.players`'s own convention. */
  players: string;
  /** ISO 8601 UTC, when this tick resolved the hit. */
  at: string;
  queued: boolean;
  /** Why it was not queued; absent when `queued` is true. */
  reason?: string;
}

export interface CreatorWatchState {
  /** Nickname -> ISO 8601 UTC of the last time its match list was read. */
  checked: Record<string, string>;
  hits: CreatorWatchHit[];
  /** UTC calendar date (YYYY-MM-DD) the one creator match queued "tonight" was claimed on. */
  queuedOn: string | null;
}

const statePath = (): string => path.join(config.mediaDir, ".creator-watch.json");

/** Missing or corrupt both read as "nothing checked yet" — the recoverable answer, as elsewhere
 *  in this repo (`telegram/state.ts`, `matchShelf.ts`). */
export function readCreatorWatchState(): CreatorWatchState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<CreatorWatchState>;
    return {
      checked:
        parsed.checked && typeof parsed.checked === "object" && !Array.isArray(parsed.checked)
          ? parsed.checked
          : {},
      hits: Array.isArray(parsed.hits) ? parsed.hits : [],
      queuedOn: typeof parsed.queuedOn === "string" ? parsed.queuedOn : null,
    };
  } catch {
    return { checked: {}, hits: [], queuedOn: null };
  }
}

/** Write-then-rename, so a crash mid-write never leaves a half-written file a later read trusts. */
export function writeCreatorWatchState(state: CreatorWatchState): void {
  const trimmed: CreatorWatchState = { ...state, hits: state.hits.slice(-MAX_STORED_HITS) };
  const file = statePath();
  writeFileSync(`${file}.tmp`, JSON.stringify(trimmed, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** This hit log since `sinceMs` — what the morning report's "since the previous report" means
 *  throughout (`facts.ts`). Pure given a state, like `experiments.ts`'s `testsSummary`. */
export function creatorWatchSince(
  sinceMs: number,
  state: CreatorWatchState = readCreatorWatchState(),
): CreatorWatchHit[] {
  return state.hits.filter((h) => Date.parse(h.at) >= sinceMs);
}

/** The watchlist names not checked within `CHECK_INTERVAL_MS` — "cheap: one list call per name
 *  per tick at most". */
export function dueNicknames(
  nicknames: readonly string[],
  checked: Readonly<Record<string, string>>,
  nowMs: number,
): string[] {
  return nicknames.filter((n) => {
    // Date.parse of a missing or corrupt value is NaN, which (unlike undefined on its own) must
    // still count as due — not silently "not due forever", the one difference from before.
    const last = Date.parse(checked[n] ?? "");
    return Number.isNaN(last) || nowMs - last >= CHECK_INTERVAL_MS;
  });
}

/**
 * Whether a watched creator's match is worth evaluating further: new to the watch, not already
 * known to the dashboard by any other route, and no blocked player. A match that fails this is
 * simply not this feature's business — the dashboard's ordinary flow already has it, or house
 * rule already forbids it — so nothing is recorded for it (never even a "no Twitch VOD" line);
 * only a match that gets this far and then lacks a VOD is worth telling the operator about.
 */
export function isWatchCandidate(
  m: FeedMatch,
  ctx: {
    seen: ReadonlySet<number>;
    processed: ReadonlySet<number>;
    hidden: ReadonlySet<number>;
    queued: ReadonlySet<number>;
  },
): boolean {
  return (
    !ctx.seen.has(m.id) &&
    !ctx.processed.has(m.id) &&
    !ctx.hidden.has(m.id) &&
    !ctx.queued.has(m.id) &&
    !blockedIn(m.players.map((p) => p.nickname)) &&
    !isDnf(m)
  );
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface CreatorWatchDeps {
  /** A nickname's few most recent ranked matches, newest first — `getUserMatches`'s own shape. */
  listMatches: (nickname: string) => Promise<FeedMatch[]>;
  /** Whether both players' Twitch VODs can be found — the pipeline's own discovery
   *  (`withDiscoveredVods`), the same call `nightly.ts`'s `playoffVodsReady` makes. */
  checkVods: (matchId: number) => Promise<boolean>;
}

export function liveDeps(): CreatorWatchDeps {
  return {
    listMatches: (nick) => getUserMatches(nick, { type: RANKED_TYPE, count: RECENT_COUNT }),
    checkVods: async (matchId) => {
      const match = await withDiscoveredVods(await getMatch(matchId));
      return match.players.every((p) => match.vod.some((v) => v.uuid === p.uuid));
    },
  };
}

/**
 * Removes a match directory iff this tick's own VOD probe is the only thing that could have
 * created it, and nothing else has touched it since: `withDiscoveredVods`'s only possible write
 * for a brand-new directory is `vods.json` (`src/pipeline/vodDiscovery.ts`), so any other entry
 * means a real working directory got started here — by the render pipeline, in the same
 * process — and must never be touched. Every match that reaches this feature's VOD check has
 * already passed `isWatchCandidate`, which requires `ctx.processed.has(m.id)` to be false, so it
 * provably had no directory at all when this tick began; a `checkVods` call that finds under two
 * VODs, or throws, or finds both but loses the one-a-night race to `queuedTonight`, must not leave
 * that directory behind — doing
 * so poisons `listProcessedMatchIds()` forever (every later scan, suggestion and nightly run sees
 * "already has a working directory" and skips the match for good, with no VOD ever on disk to
 * show why).
 */
function removeStrayVodsDir(matchId: number): void {
  try {
    const dir = matchDir(matchId);
    const entries = readdirSync(dir);
    if (entries.every((e) => e === "vods.json")) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Not there, or not readable — nothing to clean up.
  }
}

/** Guards against a second overlapping call — a slow `yt-dlp`/API round trip can outlast the
 *  15-minute cadence `server.ts` calls this on, same shape as `shortFlow.ts`'s `ticking` and
 *  `experimentsEvaluator.ts`'s `evaluating`. Without it, two concurrent runs each see their own
 *  stale `queuedOn` snapshot (breaking the one-a-night cap) and the one whose
 *  `writeCreatorWatchState` lands last silently overwrites the other's recorded hits/checks. */
let ticking = false;

/**
 * The 15-minute tick's own call (`server.ts`). A no-op when the feature is off or watches
 * nobody, or when a previous call is still running. A failing nickname (a typo, a dead account)
 * logs one line and costs the rest of the tick nothing; a failing VOD check, or anything
 * unexpected about one feed entry (an API shape this code did not expect), is recorded as its own
 * reason rather than retried forever or allowed to discard the whole tick's progress.
 */
export async function creatorWatchTick(
  nowMs: number = Date.now(),
  deps: CreatorWatchDeps = liveDeps(),
): Promise<void> {
  if (!config.creatorWatch || config.creatorWatchlist.length === 0) return;
  if (ticking) return;
  ticking = true;
  try {
    const state = readCreatorWatchState();
    const due = dueNicknames(config.creatorWatchlist, state.checked, nowMs);
    if (due.length === 0) return;

    const seen = new Set(state.hits.map((h) => h.matchId));
    const processed = new Set(listProcessedMatchIds());
    const hidden = hiddenMatchIds();
    let queuedTonight = state.queuedOn === utcDate(nowMs);
    let changed = false;
    const nowIso = new Date(nowMs).toISOString();

    for (const nick of due) {
      state.checked[nick] = nowIso;
      changed = true;

      let feed: FeedMatch[];
      try {
        feed = await deps.listMatches(nick);
      } catch (err) {
        console.error(`creator watch: ${nick}'s matches could not be read — ${describeError(err)}`);
        continue;
      }

      // Read fresh per nickname: an earlier name this same tick may just have claimed the queue.
      const queued = new Set(nightlyQueue());
      for (const m of feed) {
        try {
          if (!isWatchCandidate(m, { seen, processed, hidden, queued })) continue;
          // ponytail: resolved below, once, however it comes out — a VOD-less or cap-missed match
          // is never retried by a later tick. Good enough while hits are rare; if a real miss (a
          // VOD that shows up late, or the cap freeing up the same night) ever needs a second
          // look, read this against a short TTL instead of "ever".
          seen.add(m.id);
          changed = true;
          const players = m.players.map((p) => p.nickname).join(" vs ");

          let bothVods: boolean;
          try {
            bothVods = await deps.checkVods(m.id);
          } catch (err) {
            state.hits.push({
              matchId: m.id,
              nick,
              players,
              at: nowIso,
              queued: false,
              reason: `could not check Twitch VODs (${describeError(err)})`,
            });
            removeStrayVodsDir(m.id);
            continue;
          }
          if (!bothVods) {
            state.hits.push({
              matchId: m.id,
              nick,
              players,
              at: nowIso,
              queued: false,
              reason: "no Twitch VOD",
            });
            removeStrayVodsDir(m.id);
            continue;
          }
          if (queuedTonight) {
            state.hits.push({
              matchId: m.id,
              nick,
              players,
              at: nowIso,
              queued: false,
              reason: "a creator match is already queued for tonight",
            });
            removeStrayVodsDir(m.id);
            continue;
          }

          setNightlyQueue([m.id, ...nightlyQueue().filter((id) => id !== m.id)]);
          queuedTonight = true;
          state.queuedOn = utcDate(nowMs);
          state.hits.push({ matchId: m.id, nick, players, at: nowIso, queued: true });
        } catch (err) {
          // Anything else — isWatchCandidate or the player-name mapping, on a feed shape this
          // code did not expect — must not propagate: that would abort the whole tick and lose
          // every checked/hits update already made for every nickname before this one. Resolved
          // once, ever, like every other miss, rather than relitigating the same bad entry every
          // 15 minutes.
          seen.add(m.id);
          changed = true;
          state.hits.push({
            matchId: m.id,
            nick,
            players: "",
            at: nowIso,
            queued: false,
            reason: `could not evaluate the feed entry (${describeError(err)})`,
          });
          console.error(
            `creator watch: match ${m.id} from ${nick}'s feed could not be evaluated — ${describeError(err)}`,
          );
        }
      }
    }

    if (changed) writeCreatorWatchState(state);
  } finally {
    ticking = false;
  }
}
