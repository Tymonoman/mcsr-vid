/**
 * Up to 3 title-hook options for a match — the one function both the Telegram approval message
 * and auto-hooks read, so they always see the same list (18 Oct 2026, the operator's complaint:
 * titles were spoiling the match and had collapsed into one template).
 *
 * A hook here is never about what happens in the race (`titleEventProblem`) — only the runners,
 * via the operator's own `config.runnerNicknames`, or the matchup and its setting, from a
 * title-only model call that never watches the video. See handbook/claude-md-reference.md for
 * the full history.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo, UserDetails } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { bastionPhrase, seedPhrase } from "./description.js";
import {
  buildHookSuggestions,
  hookLabelProblem,
  spoilsTheResult,
  titleEventProblem,
  type HookInput,
} from "./hooks.js";
import { computeMetrics } from "./matchScore.js";
import { runnerNickname } from "./title.js";
import { playoffContextFor } from "../playoffs/playoffs.js";
import { hookFactsMatchId, readSeriesRecord } from "../playoffs/series.js";
import { titleFor } from "../shorts/videoPick.js";
import { describeFailure, runClaude } from "../telegram/claude.js";
import { allUploads } from "../youtube/youtubeStore.js";

export interface TitleOptions {
  options: string[];
  source: ("nicknames" | "model" | "chip")[];
  /** Why there are fewer than 3 (or none): the model was unavailable, nothing passed, … */
  reason?: string;
}

const cacheFile = (matchId: number): string => path.join(matchDir(matchId), "title-options.json");

/**
 * Up to 3 title-hook options, cached per match (`<matchDir>/title-options.json`) so the Telegram
 * message and auto-hooks see the same list for the same pick. `fresh: true` re-asks the model and
 * overwrites the cache; a corrupt cache file is treated the same as a missing one.
 */
export async function titleOptions(matchId: number, opts: { fresh?: boolean } = {}): Promise<TitleOptions> {
  const file = cacheFile(matchId);
  if (!opts.fresh && existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as TitleOptions;
    } catch {
      // Falls through and regenerates — a truncated cache is no better than a missing one.
    }
  }
  const result = await buildTitleOptions(matchId);
  try {
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`titleOptions #${matchId}: could not write the cache — ${describeError(err)}`);
  }
  return result;
}

const MAX_OPTIONS = 3;
/** The channel's own recent titles, for the model's "don't repeat yourself" instruction only. */
const PAST_TITLES = 20;

const TITLE_SYSTEM_PROMPT = `You write the opening "hook" phrase of a Minecraft speedrunning race video's title. The full title reads "<your hook> | RunnerA vs RunnerB | …", so your hook never needs their names.

Answer with exactly 3 lines, one hook option per line, nothing else — no numbering, no bullets, no quotes, no explanation.

Rules, every one of them:
- Tone: a meme or movie line (in the spirit of THE DUALITY OF MAN, THE CALM BEFORE THE STORM) or funny and irreverent (in the spirit of DON'T DIG STRAIGHT DOWN KIDS, LAVA DOESN'T FORGIVE). Write your own — never reuse an example's exact words.
- It must make sense to someone who has not watched the match. "THE FORTRESS RUNBACK" failed this: a cold viewer has no idea what it refers to.
- About the matchup, the runners in general, or the race's setting — NEVER about what happens during the race itself. No lead, gap, swing, death, hearts, comeback, overtake, reset, splits reached, or a finishing time.
- No digits anywhere, unless you are told the match was decided by under a second — only then is a number allowed.
- Never name either runner, and never use any nickname, label or epithet for one, their real username included. A hook is about the race, not a person.
- Something new each time: never reuse an idea from the channel's recent titles you are given below.
- Your 3 options should differ from each other in style.
- Each must fit the character budget given below.

Curated examples, for the tone only (never reuse their words): THE DUALITY OF MAN, A DRAGON FIGHT FOR TWO, THE CALM BEFORE THE STORM, DON'T DIG STRAIGHT DOWN KIDS, LAVA DOESN'T FORGIVE, WHO BLINKS FIRST?`;

function titlePrompt(input: {
  seedType: string | null;
  bastionType: string | null;
  closeMs: number | null;
  hookMax: number;
  pastTitles: string[];
}): string {
  const setting =
    [input.seedType, input.bastionType].filter((s): s is string => s !== null).join(", ") || "unknown";
  return `Setting: ${setting}
Decided by under a second: ${input.closeMs !== null ? `yes, ${input.closeMs} ms — a number is allowed` : "no — do not use any digits"}
Character budget: ${input.hookMax}
${
  input.pastTitles.length > 0
    ? `The channel's recent titles, for style only — never reuse one of these ideas:\n${input.pastTitles.map((t) => `- ${t}`).join("\n")}`
    : ""
}`;
}

/** Tolerates a numbered or bulleted answer, same as `HOOK_SUGGEST_CMD` (hooks.ts) — a model
 *  returns one unless told twice. */
function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .replace(/^["']+|["']+$/g, ""),
    )
    .filter((l) => l.length > 0);
}

async function buildTitleOptions(matchId: number): Promise<TitleOptions> {
  let match: MatchInfo;
  try {
    match = await getMatch(matchId);
  } catch (err) {
    return { options: [], source: [], reason: `could not read the match (${describeError(err)})` };
  }
  const [left, right] = match.players;
  if (!left || !right) return { options: [], source: [], reason: `match ${matchId} has no two players` };

  const dir = matchDir(matchId);
  const series = await readSeriesRecord(dir);
  const playoff = series ? null : await playoffContextFor(match);
  const hookMax = titleFor(match, series, playoff).hookMax;
  // A joined series' facts read the game that decided it, not game 1's (hookFactsMatchId) — the
  // same rule hooks.ts chips and the Short's own suggestions are held to elsewhere.
  const factsId = hookFactsMatchId(matchId, series);
  const factsMatch = factsId === matchId ? match : await getMatch(factsId).catch(() => match);
  const metrics = computeMetrics(factsMatch);
  const marginMs = metrics.finishMarginMs;
  const closeMs = marginMs !== null && marginMs > 0 && marginMs < 1_000 ? marginMs : null;

  const options: string[] = [];
  const source: TitleOptions["source"] = [];

  /** Every check a model or chip phrase hook has to pass; the nicknames pair below is operator
   *  grant, not re-checked against the event/digit or spoiler rules. */
  const add = (text: string, from: "model" | "chip"): void => {
    if (options.length >= MAX_OPTIONS) return;
    const t = text.trim();
    if (
      t === "" ||
      t.length > hookMax ||
      options.includes(t) ||
      hookLabelProblem(t, match.players) !== null ||
      titleEventProblem(t, { marginMs }) !== null ||
      spoilsTheResult(t, match.players)
    )
      return;
    options.push(t);
    source.push(from);
  };

  const leftNick = runnerNickname(left.nickname);
  const rightNick = runnerNickname(right.nickname);
  if (leftNick && rightNick) {
    const pair = `${leftNick.toUpperCase()} vs ${rightNick.toUpperCase()}`;
    if (pair.length <= hookMax) {
      options.push(pair);
      source.push("nicknames");
    }
  }

  let reason: string | undefined;
  if (options.length < MAX_OPTIONS) {
    const pastTitles = (await allUploads())
      .sort((a, b) => (a.record.uploadedAt < b.record.uploadedAt ? 1 : -1))
      .slice(0, PAST_TITLES)
      .map((u) => u.record.title);
    const reply = await runClaude(
      titlePrompt({
        seedType: seedPhrase(factsMatch),
        bastionType: bastionPhrase(factsMatch),
        closeMs,
        hookMax,
        pastTitles,
      }),
      { systemPrompt: TITLE_SYSTEM_PROMPT },
    );
    if (reply.ok) {
      for (const line of parseLines(reply.text)) add(line, "model");
    } else {
      reason = `the model was unavailable (${describeFailure(reply)})`;
    }
  }

  if (options.length < MAX_OPTIONS) {
    const chipInput: HookInput = {
      metrics,
      match: factsMatch,
      userLeft: { nickname: left.nickname } as UserDetails,
      userRight: { nickname: right.nickname } as UserDetails,
      playoff,
      maxChars: hookMax,
      minChars: 0,
    };
    for (const c of buildHookSuggestions(chipInput, 5)) add(c, "chip");
  }

  return options.length > 0
    ? { options, source, ...(reason ? { reason } : {}) }
    : { options, source, reason: reason ?? "nothing passed the checks for this match" };
}
