/**
 * Candidate hooks for the one part of a title a human is supposed to write.
 *
 * src/title.ts generates everything derivable from the API and leaves `<HOOK>` as a literal
 * placeholder, which meant staring at an empty box. These are not a substitute for judgement —
 * they are the facts of the match phrased as openers, so picking one is a decision rather than
 * a writing task.
 *
 * Every rule reads a field the scorer already computes (MatchMetrics), so a suggestion can
 * never claim something the video does not show. Nothing here invents superlatives: a hook that
 * says "decided by 2.4 seconds" is checkable against the splits panel in the render.
 *
 * `HOOK_SUGGEST_CMD` hands the same facts to an external generator when one is configured. The
 * built-ins are the fallback and stay the default: they cost nothing, need no network, and work
 * when the container has no model credentials.
 */
import { spawn } from "node:child_process";
import { formatShortTime } from "../remotion/format.js";
import { describeError } from "./errorText.js";
import type { MatchMetrics } from "./matchScore.js";
import { eloAtMatchStart } from "./overlayProps.js";
import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

/**
 * A rank high enough that a viewer places it without looking it up. Past this, "#843 vs #1291"
 * is two numbers rather than a rivalry.
 */
const RECOGNISABLE_RANK = 100;

/** A hook nobody would read as a hook. Below this a suggestion is noise, not a shorter option. */
const MIN_USEFUL_CHARS = 8;

/** How long to wait on an external generator before falling back. */
const CMD_TIMEOUT_MS = 20_000;

export interface HookInput {
  metrics: MatchMetrics;
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  /** buildTitle().hookMax — the longest hook that keeps both nicknames above the mobile cutoff. */
  maxChars: number;
  /** buildTitle().hookMin — shorter than this and the title falls under the 70-char band. */
  minChars: number;
  /**
   * Head-to-head record, for the rematch hook. Optional: it is one more API call than the rest
   * of the facts need, so a caller that cannot afford it — or whose request failed — simply
   * omits the chip.
   */
  versus?: VersusStats;
}

interface Candidate {
  text: string;
  /** Higher wins. Roughly "how much of the match's interest does this one fact capture". */
  weight: number;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1).replace(/\.0$/, "");

/**
 * The facts, ranked. Order here is the tiebreak when several apply, and it is deliberate.
 *
 * Rivalry framing outranks everything, by measurement rather than taste. Across the first seven
 * published videos the hook *style* split CTR with no overlap: the three "X vs Y" hooks (YN vs
 * TAS 9.61%, UNC vs CATBOY 8.33%, WANNABE vs REAL GOAT 8.04%) weighted to 9.36%, while the four
 * descriptive/event/joke hooks (INSANELY CLOSE MATCHUP 3.75%, "They REALLY think they'll get
 * RANK #1" 3.29%, SILENT ACCEPTANCE 3.25%, DON'T DIG STRAIGHT DOWN KIDS 2.01%) weighted to
 * 2.25%. A contrast between two people is a reason to click; a description of the match is not.
 * So every rivalry candidate sits in the 100-130 band and every descriptive one below it, which
 * means a descriptive hook reaches the top of the list only when the match has no rivalry to
 * state — the dashboard used to nudge the operator into the 2.25% format on every upload.
 *
 * Within the rivalry band a shared history beats an upset beats a ranking beats a rating gap,
 * because that is how much of a story each one carries. Within the descriptive band the old
 * order stands: a photo finish beats a lead change beats a death count.
 */
function candidates(input: HookInput): Candidate[] {
  const { metrics, match, userLeft, userRight, versus } = input;
  const out: Candidate[] = [];
  const { finishMarginMs, leadChanges, maxSwingMs, deaths, resultMs, winner } = metrics;

  // --- Rivalry framing (100-130) ----------------------------------------------------------
  // Match-time elo, not live elo: reading the rating at render time once turned a real
  // 106-point gap into a displayed 245-point one (see src/description.ts).
  const leftElo = eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate);
  const rightElo = eloAtMatchStart(match, userRight.uuid, userRight.eloRate);

  if (versus) {
    const leftWins = versus.results.ranked[userLeft.uuid] ?? 0;
    const rightWins = versus.results.ranked[userRight.uuid] ?? 0;
    // Both sides have to have won one for this to read as a rivalry. A one-sided record gets
    // no chip; a first meeting gets a descriptive one — the active competitor's "Their First
    // 1v1" drew 4.9k views against its 3.3k median (8 Sept 2026), so it is a reason to click,
    // if a weaker one than a close finish.
    if (leftWins >= 1 && rightWins >= 1) {
      const leader = leftWins >= rightWins ? userLeft.nickname : userRight.nickname;
      const hi = Math.max(leftWins, rightWins);
      const lo = Math.min(leftWins, rightWins);
      out.push({
        text: hi === lo ? `Rematch: ${hi}-${lo} all time` : `Rematch: ${leader} leads ${hi}-${lo}`,
        weight: 130,
      });
    } else if (leftWins === 0 && rightWins === 0) {
      out.push({ text: "Their first 1v1", weight: 92 });
    }
  }

  // The favourite and the underdog, never the winner: the ending is the reason to watch, and
  // "The 1789 takes down the 2080" gave it away on the thumbnail. A question, and asked whenever
  // the gap is wide enough to be one — if it only appeared for upsets, it would answer itself.
  if (leftElo > 0 && rightElo > 0 && Math.abs(leftElo - rightElo) >= 100) {
    const low = Math.min(leftElo, rightElo);
    const high = Math.max(leftElo, rightElo);
    const upset = winner !== null && (winner === userLeft.nickname ? leftElo : rightElo) === low;
    out.push({ text: `Can the ${low} take down the ${high}?`, weight: upset ? 125 : 60 });
  }

  // Current rank, not rank at match time: the API carries no historical rank the way `changes`
  // carries historical elo, so there is nothing to reconstruct. Acceptable where a stale elo was
  // not, because "#4" is the standing a viewer recognises today, whereas a stale rating silently
  // contradicted the one the overlay shows.
  const leftRank = userLeft.eloRank;
  const rightRank = userRight.eloRank;
  if (
    typeof leftRank === "number" &&
    typeof rightRank === "number" &&
    leftRank <= RECOGNISABLE_RANK &&
    rightRank <= RECOGNISABLE_RANK
  ) {
    out.push({ text: `#${leftRank} vs #${rightRank}`, weight: 115 });
  }

  // The same gap without claiming a result — just the matchup. Numbers rather than "the
  // favourite vs the underdog" because a number is checkable against the overlay.
  if (leftElo > 0 && rightElo > 0 && Math.abs(leftElo - rightElo) >= 100) {
    out.push({
      text: `${Math.max(leftElo, rightElo)} vs ${Math.min(leftElo, rightElo)}`,
      weight: 105,
    });
  }

  // --- Descriptive fallbacks (below 100) --------------------------------------------------

  if (finishMarginMs !== null) {
    // Under three seconds after eight-plus minutes is the whole story; the scorer uses the same
    // 3s window to call a split "close".
    if (finishMarginMs < 3_000)
      out.push({ text: `Decided by ${seconds(finishMarginMs)} seconds`, weight: 95 });
    else if (finishMarginMs < 10_000)
      out.push({ text: `${seconds(finishMarginMs)} seconds apart`, weight: 65 });
  } else {
    // The loser usually stops once the winner is done, so a null margin is normal, not dramatic.
    out.push({ text: "One of them never reached the dragon", weight: 25 });
  }

  if (match.forfeited) out.push({ text: "It ended in a forfeit", weight: 60 });

  if (leadChanges >= 3) out.push({ text: `The lead changed ${leadChanges} times`, weight: 80 });
  else if (leadChanges === 2) out.push({ text: "The lead changed twice", weight: 50 });

  // A swing is the largest single-split collapse, which is the thing that actually looks
  // dramatic on the splits panel.
  if (maxSwingMs >= 60_000) out.push({ text: `A ${formatShortTime(maxSwingMs)} lead, gone`, weight: 75 });
  else if (maxSwingMs >= 30_000)
    out.push({ text: `${Math.round(maxSwingMs / 1000)} seconds swung it`, weight: 45 });

  if (deaths === 0) out.push({ text: "Not a single death between them", weight: 40 });
  else if (deaths >= 4) out.push({ text: `${deaths} deaths and still this close`, weight: 55 });

  // The actual minute, not "sub-10": "SUB 7" and "Insane 6:51" both ran ~1.5x the competitor's
  // median, and a sub-8 is news in a way a sub-10 no longer is.
  if (resultMs > 0 && resultMs < 600_000) {
    const minute = Math.floor(resultMs / 60_000) + 1;
    out.push({ text: `A sub-${minute} to win it`, weight: minute <= 8 ? 90 : 57 });
  }

  return out;
}

/**
 * Ranked hook suggestions, most interesting first.
 *
 * Over-length candidates are dropped rather than truncated: a hook cut mid-word is worse than
 * one fewer option. Length is otherwise only a tiebreak — a short hook merely leaves the title
 * under the 70-character band, which the counter shows and the editor can fix in a word, while
 * a duller hook cannot be fixed at all. Sorting the other way round put "one of them never
 * reached the dragon" (routine: the loser stops once the winner is done) above a four-lead-change
 * race, purely because the dull one happened to be longer.
 */
export function buildHookSuggestions(input: HookInput, limit = 5): string[] {
  const seen = new Set<string>();
  return candidates(input)
    .filter((c) => c.text.length >= MIN_USEFUL_CHARS && c.text.length <= input.maxChars)
    .filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)))
    .sort((a, b) => {
      const inBand = (c: Candidate) => (c.text.length >= input.minChars ? 1 : 0);
      return b.weight - a.weight || inBand(b) - inBand(a);
    })
    .slice(0, limit)
    .map((c) => c.text);
}

/** Exactly the facts a generator needs; no prose, so the prompt lives in the command, not here. */
export function hookFacts(input: HookInput) {
  const { metrics, match, userLeft, userRight } = input;
  return {
    matchId: metrics.matchId,
    players: metrics.players,
    winner: metrics.winner,
    resultMs: metrics.resultMs,
    finishMarginMs: metrics.finishMarginMs,
    finishEstimated: metrics.finishEstimated,
    leadChanges: metrics.leadChanges,
    maxLeadMs: metrics.maxLeadMs,
    maxSwingMs: metrics.maxSwingMs,
    deaths: metrics.deaths,
    deathsByPlayer: metrics.deathsByPlayer,
    splits: metrics.splits,
    forfeited: match.forfeited,
    elo: {
      left: eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate),
      right: eloAtMatchStart(match, userRight.uuid, userRight.eloRate),
    },
    /** Live standings — there is no match-time rank to read back, see candidates(). */
    rank: { left: userLeft.eloRank ?? null, right: userRight.eloRank ?? null },
    /** Ranked wins between these two, or null when the caller did not fetch them. */
    h2h: input.versus
      ? {
          left: input.versus.results.ranked[userLeft.uuid] ?? 0,
          right: input.versus.results.ranked[userRight.uuid] ?? 0,
        }
      : null,
    maxChars: input.maxChars,
    minChars: input.minChars,
  };
}

/**
 * Runs `HOOK_SUGGEST_CMD` with the match facts on stdin, one suggestion per stdout line.
 *
 * Deliberately a command rather than a client for any particular tool: the antigravity CLI is
 * not set up yet, and whatever ends up generating these should be swappable without a release.
 * Any failure — unset, missing binary, timeout, empty output — falls back to the built-ins,
 * because an empty hook box is a worse outcome than a less clever hook.
 */
export async function suggestHooksExternally(input: HookInput): Promise<string[] | null> {
  const command = process.env.HOOK_SUGGEST_CMD;
  if (!command || command.trim() === "") return null;

  try {
    const stdout = await runCommand(command, JSON.stringify(hookFacts(input)));
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      // Tolerate a numbered or bulleted list, which is what a model returns unless told twice.
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
      .filter((line) => line.length >= MIN_USEFUL_CHARS && line.length <= input.maxChars);
    return lines.length > 0 ? lines.slice(0, 5) : null;
  } catch (err) {
    console.error(`HOOK_SUGGEST_CMD failed, using built-in hooks: ${describeError(err)}`);
    return null;
  }
}

function runCommand(command: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), CMD_TIMEOUT_MS);

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // A generator is free to ignore the facts on stdin, and one that exits without reading them
    // closes the pipe under our write. Unhandled, that EPIPE is an 'error' event on the socket
    // and takes the whole dashboard down; the child's exit code is the outcome that matters, so
    // it is swallowed here and the close handler decides.
    proc.stdin.on("error", () => {});
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") reject(new Error(`timed out after ${CMD_TIMEOUT_MS}ms`));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`exited with code ${code}: ${stderr.slice(-500)}`));
    });

    proc.stdin.end(stdin);
  });
}
