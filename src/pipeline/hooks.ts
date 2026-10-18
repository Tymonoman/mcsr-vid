/**
 * Candidate hooks for the one part of a title a human is supposed to write.
 *
 * src/pipeline/title.ts generates everything derivable from the API and leaves `<HOOK>` as a literal
 * placeholder, which meant staring at an empty box. These are not a substitute for judgement —
 * they are the facts of the match phrased as openers, so picking one is a decision rather than
 * a writing task.
 *
 * Every rule reads a field the scorer already computes (MatchMetrics), so a suggestion can
 * never claim something the video does not show. Nothing here invents superlatives: a hook that
 * says "decided by 320 milliseconds" is checkable against the splits panel in the render.
 *
 * `HOOK_SUGGEST_CMD` hands the same facts to an external generator when one is configured. The
 * built-ins are the fallback and stay the default: they cost nothing, need no network, and work
 * when the container has no model credentials.
 */
import { spawn } from "node:child_process";
import { describeError } from "../errorText.js";
import { seedPhrase } from "./description.js";
import type { MatchMetrics } from "./matchScore.js";
import { eloAtMatchStart, h2hWinsBefore } from "./overlayProps.js";
import { runnerNickname, titleName } from "./title.js";
import type { PlayoffContext } from "../playoffs/playoffs.js";
import type { MatchInfo, UserDetails, VersusStats } from "../api/types.js";

/**
 * Shapes a hook suggestion may not carry:
 * - a bracket seed ("#7 seed", "7th seed", "the LCQ" as a seed pairing)
 * - a ladder rank ("#31 vs #14", "#1 WORLD", "RANK 1", "TOP 10", "WORLD NUMBER ONE")
 * - an elo pairing ("2427 vs 2293", "Can the 1789 take down the 2080?"), or any elo at all
 *   ("THE 2100 ELO RUNNER?", "HIGH ELO CLASH" — the model's prompt carries each player's elo)
 */
// A bracket seed only ("7th seed", "#7 seed", "top seed", "the LCQ"): the world's seed type
// ("village seed", "same seed") is fair game for a hook. Also the word "elo" and a lone rank
// ("RANK 1", "RANKED #5", "TOP 10", "THE NO. 1 SEED", "WORLD NUMBER ONE") — "no" needs its period,
// so "NO ONE SAW THAT COMING" still passes. A lone 1000-3999 is an elo ("CAN ANYONE STOP THE
// 2400?") unless milliseconds follow; no chip carries a four-digit number. A rating by its unit
// too ("A 600-POINT GAP?", "2100 RATED", 15 Oct 2026).
export const HOOK_SEED_RANK_ELO =
  /\b\d{3,4}\s*-?\s*(?:points?|pts|rated)\b|#\d+|\b\d+(?:st|nd|rd|th) seed\b|\blcq\b|\b\d{3,4}\b[^\d]+\b\d{3,4}\b|\b[1-3]\d{3}\b(?!\s*(?:ms|milliseconds?)\b)|\belo\b|\btop seed\b|\btop\s+\d+\b|\bno\.\s*\d+|\bnumber\s*(?:\d+|one)\b|\brank(?:ed)?\s*#?\d+\b/i;

/**
 * Words that name a runner by race, ethnicity or nationality, or a slur-adjacent abbreviation of
 * one — never a hook, "vs" or not (2 Oct 2026: "LCQ vs YN" and "ASIAN VS CARNIVORE" both went out
 * this way and were called out in public as naming a runner by a slur and a race label). Short on
 * purpose: a false positive costs one dropped suggestion or a warning beside a typed field, never
 * a refusal — see `hookLabelProblem`.
 */
const HOOK_DENIED_LABELS =
  /\b(?:yn|asian|asians|black|white|latino|latina|hispanic|african|arab|arabs|european|american|chinese|korean|japanese|mexican|indian)\b/i;

/**
 * A hook that names a runner with a label: either `HOOK_DENIED_LABELS` on its own, or a "<x> vs
 * <y>" shape ("vs", "vs.", "v", "v." or "versus", any number of sides) where a side is not one of
 * `players`' real nicknames or `titleNames` spellings — an invented nickname ("LCQ", "TAS",
 * "CARNIVORE") standing in for a runner. `players` is the
 * match the hook is for; omit it where that is not at hand and only the denied-label half runs.
 *
 * The root cause (2 Oct 2026): the title-hook model had been shown the operator's own past hooks
 * as style examples and reused "YN" from one ("YN vs TAS") onto a different match's different
 * player. `pastTitleHooks` (videoPick.ts) no longer shows the model a "vs" hook to copy at all;
 * this is the second line of defence for whatever a model proposes or the operator types anyway —
 * dropped from a model's proposal, a warning beside a typed one (`hookProblem`, `writeHooks`).
 *
 * A side may also be the operator's own `runnerNicknames` spelling (18 Oct 2026): that pair is
 * code assembling what the operator typed in Settings, not an invented label.
 */
export function hookLabelProblem(hook: string, players?: readonly { nickname: string }[]): string | null {
  const problem = "names a runner with a label: runners have objected to this (2 Oct 2026)";
  if (HOOK_DENIED_LABELS.test(hook)) return problem;
  if (!players) return null;
  const sides = hook.split(/\s+(?:vs\.?|v\.?|versus)\s+/i);
  if (sides.length < 2) return null;
  const known = new Set(
    players.flatMap((p) => {
      const operator = runnerNickname(p.nickname);
      return [
        p.nickname.toLowerCase(),
        titleName(p.nickname).toLowerCase(),
        ...(operator ? [operator.toLowerCase()] : []),
      ];
    }),
  );
  return sides.some((s) => !known.has(s.trim().toLowerCase())) ? problem : null;
}

/**
 * Words that describe something happening in the match — a lead, a death, a comeback — never a
 * title hook's business (18 Oct 2026: "why are you spoiling stuff that's happening in the match in
 * titles"). A digit is the same kind of tell (a margin, a lead change count, a finishing minute)
 * unless the match was actually decided inside a second, the one case the operator still wants a
 * number for. Forfeit is not on this list: `candidates()` keeps "It ended in a forfeit" as a plain
 * circumstance, not a spoiler.
 */
const TITLE_EVENT_WORDS =
  /\b(?:lead|gap|swing|swings|comeback|overtakes?|overtaken|deaths?|died|dying|hearts?|resets?|splits?|chokes?|choked|clutch|clutches|pace|margin|survives?|survived)\b/i;

/** The segment of a title hook the operator's new rule (18 Oct 2026) refuses: it describes what
 *  happens in the match, rather than the runners or the setting. `marginMs` is the match's own
 *  finish margin (null when there is none) — a number is allowed only under a second. */
export function titleEventProblem(hook: string, { marginMs }: { marginMs: number | null }): string | null {
  const problem = "describes what happens in the match — a title is about the runners or the setting";
  if (TITLE_EVENT_WORDS.test(hook)) return problem;
  if (/\d/.test(hook) && !(marginMs !== null && marginMs > 0 && marginMs < 1_000)) return problem;
  return null;
}

/** A hook nobody would read as a hook. Below this a suggestion is noise, not a shorter option. */
const MIN_USEFUL_CHARS = 8;

/** How long to wait on an external generator before falling back. */
const CMD_TIMEOUT_MS = 20_000;

export interface HookInput {
  metrics: MatchMetrics;
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  /** A playoff game's context: the seeds frame the matchup where the ladder rank would. */
  playoff?: PlayoffContext | null;
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

/**
 * "Decided by N seconds", grammatically and factually right at every scale (6 Oct 2026 panel —
 * `seconds()` used to strip a trailing ".0" and leave the plural word behind, so a 1033ms margin
 * shipped as "Decided by 1 seconds": the exact "low quality" look viewers reported). Under 100ms
 * the exact millisecond count beats a rounded "0.1 seconds", which overstates a real 58ms margin
 * 1.7x (the channel's own past title was "58 MILLISECONDS"); otherwise one decimal, dropped when
 * it rounds to a whole number, and "1 second" (singular) when that whole number is 1.
 */
function secondsPhrase(ms: number): string {
  if (ms < 100) {
    const n = Math.round(ms);
    return `${n} millisecond${n === 1 ? "" : "s"}`;
  }
  const tenths = Math.round(ms / 100);
  if (tenths === 10) return "1 second";
  const whole = tenths / 10;
  return `${tenths % 10 === 0 ? String(whole) : whole.toFixed(1)} seconds`;
}

/**
 * The facts, ranked. Order here is the tiebreak when several apply, and it is deliberate.
 *
 * Rewritten 18 Oct 2026 (the operator's complaint: titles were spoiling the match and had
 * collapsed into one template, "A 24-SECOND LEAD AT THE END"). A chip here is never about what
 * happens in the match — no margin, lead, death count or pace, which `titleEventProblem` also
 * refuses downstream — only the rivalry (a real head-to-head record), the setting (the seed
 * type) and, since a real close finish is still worth saying, a close-finish chip gated to
 * under a second. The forfeit chip stays: it is a circumstance, not a spoiler or a number.
 */
function candidates(input: HookInput): Candidate[] {
  const { metrics, match, userLeft, userRight, versus } = input;
  const out: Candidate[] = [];
  const { finishMarginMs } = metrics;

  // --- Rivalry framing (30-35): a real head-to-head record ----------------------------------
  // None on a playoff game: next to "Round of 16 | Game 3" a record reads as the series score.
  if (versus && !input.playoff) {
    const leftWins = h2hWinsBefore(versus, match, userLeft.uuid);
    const rightWins = h2hWinsBefore(versus, match, userRight.uuid);
    // Both sides have to have won one for this to read as a rivalry. A one-sided record gets
    // no chip; a first meeting gets a descriptive one — a reason to click, if a weaker one than
    // a close finish.
    if (leftWins >= 1 && rightWins >= 1) {
      const leader = leftWins >= rightWins ? userLeft.nickname : userRight.nickname;
      const hi = Math.max(leftWins, rightWins);
      const lo = Math.min(leftWins, rightWins);
      out.push({
        text:
          hi === lo ? `Rematch: ${hi}-${lo} this season` : `Rematch: ${leader} leads ${hi}-${lo} this season`,
        weight: 35,
      });
    } else if (leftWins === 0 && rightWins === 0) {
      out.push({ text: "Their first 1v1 this season", weight: 30 });
    }
  }

  // --- The setting: always available, never a spoiler ---------------------------------------
  const setting = seedPhrase(match);
  if (setting) out.push({ text: `A ${setting} race`, weight: 20 });

  if (match.forfeited) out.push({ text: "It ended in a forfeit", weight: 60 });

  // --- A real close finish, numbers and all — the one case the operator still wants a figure
  // (18 Oct 2026: "only if it's a reaaaally close match"). A dead heat (0ms) was decided by
  // nothing, so it gets no chip.
  if (finishMarginMs !== null && finishMarginMs > 0 && finishMarginMs < 1_000)
    out.push({ text: `Decided by ${secondsPhrase(finishMarginMs)}`, weight: 95 });

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

/**
 * Exactly the facts a generator needs; no prose, so the prompt lives in the command, not here.
 *
 * `winner` is deliberately absent. The built-ins use it internally to decide *which* question to
 * ask and never print it, but a generator handed the name writes "X DESTROYS Y" — and the first
 * suggestion is what the pipeline burns into the thumbnail and the Short. Not sending it makes the
 * house rule structural rather than a filter; `spoilsTheResult` below is the second line.
 */
export function hookFacts(input: HookInput) {
  const { metrics, match, userLeft, userRight } = input;
  return {
    matchId: metrics.matchId,
    players: metrics.players,
    resultMs: metrics.resultMs,
    finishMarginMs: metrics.finishMarginMs,
    finishEstimated: metrics.finishEstimated,
    leadChanges: metrics.leadChanges,
    maxLeadMs: metrics.maxLeadMs,
    maxSwingMs: metrics.maxSwingMs,
    deaths: metrics.deaths,
    splits: metrics.splits,
    forfeited: match.forfeited,
    elo: {
      left: eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate),
      right: eloAtMatchStart(match, userRight.uuid, userRight.eloRate),
    },
    /** Live standings — there is no match-time rank to read back, see candidates(). */
    rank: { left: userLeft.eloRank ?? null, right: userRight.eloRank ?? null },
    /** Ranked wins between these two this season; null when not fetched, or a playoff game. */
    h2h:
      input.versus && !input.playoff
        ? {
            left: h2hWinsBefore(input.versus, match, userLeft.uuid),
            right: h2hWinsBefore(input.versus, match, userRight.uuid),
          }
        : null,
    maxChars: input.maxChars,
    minChars: input.minChars,
  };
}

/**
 * The one shape allowed to carry "win": the pace stake itself ("A sub-8 to win it", `candidates`'
 * own highest-weighted suggestion under 8 minutes) states what winning takes, not who did.
 * Anchored to the start of the line (14 Oct 2026: unanchored, "EDCR GOES SUB-8 TO WIN IT" lost its
 * only spoiler words and kept the name; a full title still leads with its hook, so the chip in a
 * title passes) and to "sub-N ... to win" rather than a blanket `\bto win\b` strip (6 Oct 2026 panel bug,
 * fixed everywhere this is used): a blanket strip also erases the only spoiler word from a hook
 * that names a real player next to "win" language ("doogile battles back to win it"), which must
 * stay rejected. And to the end of the segment (15 Oct 2026: "A SUB-8 TO WIN IT FOR DOOGILE" lost
 * "win" and kept the name after it), so anything after the idiom is still tested. Exported so
 * `hookProblem` (videoPick.ts) strips the identical shape before its own spoiler regex runs,
 * rather than drifting from this one again.
 */
export const PACE_TO_WIN = /^\s*(?:a\s+)?sub-?\d+(?:\.\d+)?\s+to win(?:\s+it)?[ .!?]*(?=\||$)/i;

/** The End, the dragon, the finish, a finishing pace: said of a named runner, the result. */
const ENDGAME_CUE =
  /\b(?:the end|end ?fight|dragon|finish(?:es|ed|ing)?|final split|to win|sub-?\d+|record|pb|wr|on pace|seal(?:s|ed|ing)?|clinch(?:es|ed|ing)?|clos(?:e|es|ing) it out|(?:zero|one)[- ]?cycles?)\b/i;

/**
 * Whether a line gives the result away.
 *
 * A question never does — "Can the 1789 take down the 2080?" is the channel's whole framing — so
 * anything ending in "?" passes. Otherwise a verb of winning or losing next to anything is out.
 * Deliberately blunt: a false positive costs one suggestion, a false negative costs the video.
 * Since 24 Sept it also refuses the operator's typed hooks on save, so a stake is let through:
 * "A SUB-8 TO WIN IT" says what winning takes, not who did (`PACE_TO_WIN` is stripped before the
 * test — not every "to win", which would also strip the only spoiler word out of a hook naming a
 * real player, 6 Oct 2026).
 *
 * With `players`, one of the match's own runners (nickname or `titleNames` spelling, whole word)
 * named beside an `ENDGAME_CUE` spoils too: whoever is at the End on sub-8 pace is the winner to
 * anyone who knows MCSR (15 Oct 2026: the pick's "Infume on sub-8 pace at the End" passed every
 * check and auto-saved as 13140492's Short hook; Infume won). Still not a question: "Can lowk3y_
 * finish before ulsahinn?" (14035423) says nothing of who did.
 */
export function spoilsTheResult(text: string, players?: readonly { nickname: string }[]): boolean {
  const line = text.trim().replace(PACE_TO_WIN, "");
  if (line.endsWith("?")) return false;
  const names = (players ?? [])
    .flatMap((p) => [p.nickname, titleName(p.nickname)])
    .filter((n) => n !== "")
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length > 0) {
    const all = text.trim();
    const rest = all.replace(new RegExp(`(?<!\\w)(?:${names.join("|")})(?!\\w)`, "gi"), "");
    if (rest.length < all.length && ENDGAME_CUE.test(rest)) return true;
  }
  // Placements are results too: a playoff placing in a ranked video's title ("WINNER vs 3rd
  // PLACE", 23 Sept 2026) told the Season 11 bracket's outcome while its series were still
  // going out from the Round of 16. A sweep is a series result: "PLAYOFFS | SWEPT vs TAS" on a
  // best of 5 told how it went (24 Sept 2026 audit), whoever the nickname meant. So do the
  // words of how it went: "HUGE UPSET", "EDCR DOMINATES", "THE LEAD HOLDS", and a name next to a
  // finishing verb: "EDCR SEALS IT", "DOOGILE FALLS SHORT", "EDCR ADVANCES" (14 Oct 2026 edge
  // runs) — an upset is only ever a question. "advanced" only as "advanced to", so "ADVANCED
  // NETHER ROUTE" is not a result.
  return /\b(swept|sweeps?|wins?|won|winner|beats?|beaten|destroys?|crushes|takes? (?:it|down|the win)|took (?:it|the win)|loses?|lost|loser|chokes?|choked|throws?|threw|clutch(?:es|ed)?|comeback complete|survives?|eliminat(?:es|ed)|(?:1st|2nd|3rd|4th|first|second|third|fourth) place|runners?[- ]up|(?:semi-?)?finalists?|champions?|podium|upset|revenge|redemption|dominat(?:es|ed)|outplay(?:s|ed)|outpac(?:es|ed)|prevail(?:s|ed)|never (?:looked back|trailed)|wire to wire|(?:lead|it) holds|held on|takes? the (?:match|game|series|lead for good)|takes? game \d+|finish(?:es|ed)? first|seals? it|steals? it|closes? it out|falls? short|advances|advanced to)\b/i.test(
    line,
  );
}

/**
 * The segment of a title the operator typed in the Title & description fold that gives the result
 * away, or null. Only segments neither `known` title carries (the generated one, the one on disk)
 * are checked: those hold the nicknames and a round name like "3rd Place", which is the bracket,
 * not a result — and a title already saved is not re-judged on a description-only save.
 */
export function typedSpoiler(title: string, ...known: string[]): string | null {
  const segments = (t: string) =>
    t
      .split("\n")[0]!
      .split("|")
      .map((s) => s.trim());
  const ours = new Set(known.flatMap(segments));
  return segments(title).find((s) => s !== "" && !ours.has(s) && spoilsTheResult(s)) ?? null;
}

/**
 * Runs `HOOK_SUGGEST_CMD` with the match facts on stdin, one suggestion per stdout line.
 *
 * Deliberately a command rather than a client for any particular tool, so whatever generates
 * these can be swapped without a release.
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
      .filter((line) => line.length >= MIN_USEFUL_CHARS && line.length <= input.maxChars)
      .filter((line) => !spoilsTheResult(line, [input.userLeft, input.userRight]))
      .filter((line) => !HOOK_SEED_RANK_ELO.test(line))
      .filter((line) => hookLabelProblem(line, [input.userLeft, input.userRight]) === null);
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

/**
 * The suggestions, external generator first.
 *
 * The one place that decides; before this the command reached only the title editor, so a hook
 * the operator liked in the browser was not the hook the nightly burned into the thumbnail and
 * the Short. Async because the command is; the built-ins are the fallback on every failure.
 *
 * Filtered once more against the match's own two players (2 Oct 2026): `suggestHooksExternally`
 * already does this for its own output, and the built-ins never produce a "vs" shape at all, so
 * this mostly guards against a future built-in or command that does — but it means every caller
 * gets clean chips without having to remember `hookLabelProblem` itself, `pipeline.ts`'s
 * cold-start default included.
 */
export async function hookSuggestions(input: HookInput): Promise<string[]> {
  const chips = (await suggestHooksExternally(input)) ?? buildHookSuggestions(input);
  const players = [input.userLeft, input.userRight];
  return chips.filter((c) => hookLabelProblem(c, players) === null);
}
