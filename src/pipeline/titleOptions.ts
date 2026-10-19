/**
 * Up to 3 title-hook options for a match — the one function both the Telegram approval message
 * and auto-hooks read, so they always see the same list (18 Oct 2026, the operator's complaint:
 * titles were spoiling the match and had collapsed into one template).
 *
 * A hook here is never about what happens in the race (`titleEventProblem`) — only the runners,
 * via the operator's own `config.runnerNicknames`, or the matchup and its setting, from a
 * title-only model call that never watches the video. See handbook/claude-md-reference.md for
 * the full history.
 *
 * titles/v2 (18 Oct 2026, the operator: "i like the titles more funny... more wordplay with the
 * gameplay and actually speedruning tech... don't mention things in the title that didn't happen
 * in the run"): `runFacts()` grounds the model in what this match's video actually shows, the
 * prompt leans on real speedrun-tech wordplay, and a hook may never repeat an idea already on the
 * channel or already offered to another match.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { computeMetrics, deathKind } from "./matchScore.js";
import { HOOK_PLACEHOLDER, runnerNickname, titleName } from "./title.js";
import { playoffContextFor } from "../playoffs/playoffs.js";
import { hookFactsMatchId, readSeriesRecord } from "../playoffs/series.js";
import {
  pickFile,
  TECHNIQUE_GLOSSARY,
  TECHNIQUE_IDS,
  type ShortPick,
  type TechniqueId,
} from "../shorts/shortPlan.js";
import { titleFor } from "../shorts/videoPick.js";
import { describeFailure, runClaude } from "../telegram/claude.js";
import { readTelegramState } from "../telegram/state.js";
import { allUploads, splitTitle } from "../youtube/youtubeStore.js";

/** What kind of hook each option is, for A/B aggregation by style. "nicknames" is the operator's
 *  own grant (`runnerNicknames`); the model tags its own answers as one of the other four. */
export type TitleStyle = "meme" | "tech" | "setting" | "tease" | "nicknames";
const MODEL_STYLES: ReadonlySet<string> = new Set(["meme", "tech", "setting", "tease"]);

export interface TitleOptions {
  options: string[];
  source: ("nicknames" | "model" | "chip")[];
  /** Parallel to `options`. */
  styles: TitleStyle[];
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
/** The channel's own recent titles, for the model's "don't repeat yourself" style instruction. */
const PAST_TITLES = 20;

/** Opus, not the bot's Haiku: on 18 Oct 2026 Haiku's options read "SANDS TO FLAMES", "THE BURIED
 *  GAUNTLET" (the vague phrasing viewers call AI slop); Opus's "THE ONE PIECE IS REAL", "SO WE MEET
 *  AGAIN", "I DON'T LIKE SAND". A few calls a day. */
const TITLE_MODEL = "claude-opus-5-5";
/** More than `MAX_OPTIONS`, so the checks below can drop some and still leave three — raised from
 *  8 on 18 Oct 2026 as the repeat and rivalry filters below got stricter. */
const ASK_FOR = 10;

/**
 * Rivalry phrasing ("WE MEET AGAIN", "HERE WE GO AGAIN") is reserved for this one real rivalry
 * (the operator, 18 Oct 2026: "keep the we meet again only for feinberg and infume") — anyone
 * else gets no rematch joke, however many times they've actually played each other.
 */
const RIVAL_PAIRS: ReadonlyArray<readonly [string, string]> = [["Feinberg", "Infume"]];

function isRivalPair(a: string, b: string): boolean {
  return RIVAL_PAIRS.some(
    ([x, y]) =>
      (x.toLowerCase() === a.toLowerCase() && y.toLowerCase() === b.toLowerCase()) ||
      (x.toLowerCase() === b.toLowerCase() && y.toLowerCase() === a.toLowerCase()),
  );
}

/** A rivalry joke's own words — refused outright for anyone but `RIVAL_PAIRS` (the code half of
 *  the rule; the prompt is the other). */
const REMATCH_WORDS = /\b(?:again|rematch|re-match|meet|met|round two)\b/i;

/** Upper-case, punctuation stripped, whitespace collapsed — for the repeat check below. */
function titleWords(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/'/g, "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether two hooks are the same idea: any 3-word run in common, after normalising — "THIS BRIDGE
 * AIN'T BIG ENOUGH" must retire "THIS TOWN AIN'T BIG ENOUGH" even though only three of five words
 * match. Shorter than 3 words falls back to an exact match, since there is no trigram to share.
 */
function sharesIdea(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.length < 3 || wb.length < 3) return wa.join(" ") === wb.join(" ");
  const gramsOf = (words: string[]) => {
    const out = new Set<string>();
    for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(" "));
    return out;
  };
  const a3 = gramsOf(wa);
  for (const g of gramsOf(wb)) if (a3.has(g)) return true;
  return false;
}

/**
 * Why a candidate hook may not become one of this match's options, or null when it can — the one
 * gate every model or chip line runs through. Exported so the repeat and rivalry rules are
 * testable without a model call.
 */
export function titleOptionProblem(
  text: string,
  opts: {
    hookMax: number;
    players: readonly { nickname: string }[];
    marginMs: number | null;
    rival: boolean;
    /** Hooks this one must not repeat the idea of: the channel's own, other matches' offers, and
     *  whatever this match has already accepted this call. */
    taken: readonly string[];
  },
): string | null {
  if (text === "") return "empty";
  if (text.length > opts.hookMax) return `over ${opts.hookMax} characters`;
  if (hookLabelProblem(text, opts.players) !== null) return "names a runner with a label";
  if (titleEventProblem(text, { marginMs: opts.marginMs }) !== null)
    return "describes what happens in the race";
  if (spoilsTheResult(text, opts.players)) return "gives the result away";
  if (!opts.rival && REMATCH_WORDS.test(text)) return "a rematch joke outside the one tracked rivalry";
  if (opts.taken.some((t) => sharesIdea(text, t))) return "repeats an idea already used";
  return null;
}

/**
 * Speedrun-tech glossary ids a runner actually says — a keyword scan of the runners' own speech — `/watch`'s report and
 * transcript for each POV. Never `chat-*.json`: that is viewer chat, which never reaches a model
 * prompt (CLAUDE.md).
 */
const TECHNIQUE_KEYWORD: Record<TechniqueId, RegExp> = {
  "pie-ray": /\bpie[\s-]?ray|pie chart\b/i,
  glowdar: /\bglowdar\b/i,
  "e-ray": /\be-?ray\b|\bmicrolensing\b/i,
  "blind-travel": /\bblind travel\b/i,
  "educated-travel": /\beducated travel\b|\btriangulat\w*\b|\bninjabrain\b/i,
  "zero-cycle": /\bzero[\s-]?cycle\b/i,
  "one-cycle": /\bone[\s-]?cycle\b/i,
  perch: /\bperch(?:ed|ing)?\b/i,
  "end-crystals": /\bend crystals?\b/i,
  "bed-bombing": /\bbed[\s-]?bomb\w*\b/i,
  bartering: /\bbarter\w*\b/i,
  "crying-obsidian": /\bcrying obsidian\b/i,
  "f3-debug": /\bf3\b/i,
  "death-reset": /\bdeath reset\b|\bhunger reset\b/i,
  searchcrafting: /\bsearchcraft\w*\b/i,
  "blaze-bed": /\bblaze bed\b/i,
  preemptive: /\bpreemptive\w*\b/i,
  "boat-clutch": /\bboat clutch\b/i,
};

/** `<matchDir>/short-watch-left|right/report.md` + `watch.json` — not every match has one. */
const SPEECH_FILES = [
  "short-watch-left/report.md",
  "short-watch-left/watch.json",
  "short-watch-right/report.md",
  "short-watch-right/watch.json",
];

function groundedTechniques(dir: string, _pick: ShortPick | null): TechniqueId[] {
  // The pick's own `techniques` are NOT proof (19 Oct 2026): for 14075056 it listed 12 of the 18 ids,
  // "blaze-bed" among them, and "BLAZE BED & BREAKFAST" went out though both runners used TNT. A
  // technique counts only when a runner says it (below); the timeline-backed ones (blind travel,
  // bartering, crying obsidian, death reset) reach the facts through `runFacts`' own timeline read.
  const found = new Set<TechniqueId>();
  let speech = "";
  for (const f of SPEECH_FILES) {
    try {
      speech += readFileSync(path.join(dir, f), "utf8");
    } catch {
      // No /watch report for this POV — the keyword scan just finds nothing there.
    }
  }
  for (const id of TECHNIQUE_IDS) if (TECHNIQUE_KEYWORD[id].test(speech)) found.add(id);
  return [...found];
}

function readPick(dir: string, matchId: number): ShortPick | null {
  try {
    return JSON.parse(readFileSync(pickFile(dir, matchId), "utf8")) as ShortPick;
  } catch {
    return null;
  }
}

/** `MatchInfo.timelines[].type` → a plain-word fact, for either player, in a fixed declared order
 *  so "no order" never reads as "who got there first". Deliberately not every type:
 *  `death_spawnpoint`, `dragon_death` and `end.kill_dragon` lean on the result. */
const TIMELINE_FACT: Record<string, string> = {
  "projectelo.timeline.blind_travel": "blind travel",
  "nether.distract_piglin": "bartered with piglins",
  "nether.obtain_crying_obsidian": "crying obsidian",
  "adventure.shoot_arrow": "a bow",
  "adventure.ol_betsy": "a crossbow",
  "story.mine_diamond": "diamonds",
  "story.obtain_armor": "armour",
  "nether.find_fortress": "the fortress",
  "nether.find_bastion": "a bastion",
  "story.follow_ender_eye": "eye throws",
  "story.enter_the_end": "the End",
};

export interface RunFacts {
  /** Plain-word facts about what happened: no times, no order, nothing saying who did what first. */
  facts: string[];
  /** The pick's own "why" and player-moment lines — context only, never a grounding gate: a title
   *  must never use these to reveal who is ahead, who wins, or a time. */
  videoShows: string[];
}

/**
 * What actually happened in this run, for the title prompt's hard grounding rule ("don't mention
 * things in the title that didn't happen in the run"). `opts.match`/`opts.dir` let a caller that
 * already has them (a joined series' deciding game, which is not the directory pick.json and the
 * `/watch` reports live in) skip the extra fetch/read.
 */
export async function runFacts(
  matchId: number,
  opts: { match?: MatchInfo; dir?: string } = {},
): Promise<RunFacts> {
  const match = opts.match ?? (await getMatch(matchId));
  const dir = opts.dir ?? matchDir(matchId);
  const pick = readPick(dir, matchId);

  const facts = new Set<string>();
  for (const f of [seedPhrase(match), bastionPhrase(match)]) if (f) facts.add(f);
  const types = new Set(match.timelines.map((e) => e.type));
  for (const [type, fact] of Object.entries(TIMELINE_FACT)) if (types.has(type)) facts.add(fact);
  // death_spawnpoint outside the End is a hunger reset, not a death (deathKind) — the operator's
  // own "death reset" (18 Oct 2026), read off the timeline rather than guessed from a keyword.
  if (match.timelines.some((e) => deathKind(match, e) === "hungerReset")) facts.add("death reset");
  for (const id of groundedTechniques(dir, pick)) facts.add(TECHNIQUE_GLOSSARY[id].split(" — ")[0]!.trim());

  const videoShows = [pick?.why, pick?.playerMoments?.left?.line, pick?.playerMoments?.right?.line].filter(
    (l): l is string => !!l && l.trim() !== "",
  );
  return { facts: [...facts], videoShows };
}

/** `handbook/knowledge/title-memes.md`, the operator's weekly scan, resolved relative to this
 *  file so it works the same from any cwd. */
const MEMES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "handbook",
  "knowledge",
  "title-memes.md",
);

export interface TitleMeme {
  name: string;
  /** Meaning, source, title use and "fits when", collapsed to one line. */
  body: string;
}

/**
 * The newest "## Week of …" section's entries — the file keeps newest research on top — never
 * its "### Rejected" list. Optional material for the prompt: the model uses one only when the run
 * facts make it fit. A missing file (not yet created, or this branch predates it) is simply no
 * memes this run, not a failure.
 */
export function titleMemes(file = MEMES_FILE): TitleMeme[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const week = text.split(/^## Week of /m)[1];
  if (!week) return [];
  const body = week.split(/^### Rejected/m)[0] ?? week;
  return body
    .split(/\n(?=- \*\*)/)
    .map((b) => /^- \*\*(.+?)\*\*:\s*([\s\S]*)$/.exec(b.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1]!.trim(), body: m[2]!.trim().replace(/\s+/g, " ") }));
}

const TITLE_SYSTEM_PROMPT = `You write the hook that opens the title of a YouTube video: a full Minecraft speedrun race between two top MCSR Ranked runners, both streams side by side. The title reads "<HOOK> | RunnerA vs RunnerB | MCSR Ranked 1v1 | Minecraft Speedrun", so the hook never needs their names.

Be funny. Lean into puns and wordplay on the gameplay and on real speedrunning tech — the glossary below is there to be played with, not recited. The channel's best title ever is THE DUALITY OF MAN. The operator's own picks, for style: WHO LET THE HOGS OUT? (stables bastion), PIRATES OF THE BASTION (buried treasure seed, treasure bastion), THIS BRIDGE AIN'T BIG ENOUGH (bridge bastion), THERE'S NO PLACE LIKE HOUSING, NOT IN MY HOUSE, NEIGHBOURS FROM HELL (village seed, housing), STABLES? IN THIS ECONOMY?, A STABLE RELATIONSHIP, X MARKS THE SPOT (buried treasure), SAND DOESN'T FORGIVE (desert temple), BURIED TREASURE ENERGY — and for the one rivalry this channel tracks, WE MEET AGAIN / HERE WE GO AGAIN.

What a good hook is:
- a recognisable meme, movie line, song lyric or internet phrase, bent to fit the run's own setting or technique (THIS BRIDGE AIN'T BIG ENOUGH for a bridge bastion), or
- a pun on a speedrun term itself (STABLES? IN THIS ECONOMY? for a stables bastion), or
- a dry joke a speedrunner would actually laugh at, or
- a plain, honest tease that makes sense to someone who has never seen the match (WHO BLINKS FIRST?).
Say it the way a person types a title, not the way a fantasy novel narrates. Viewers call vague epic phrasing "AI slop": never words like awaits, gauntlet, fate, destiny, saga, legend, realm, clash, showdown, quest, beckons, whispers, reckoning, "for none", "to flames", "below".

Speedrun-tech glossary, for wordplay only:
${TECHNIQUE_IDS.map((id) => `- ${TECHNIQUE_GLOSSARY[id]}`).join("\n")}
- fortress and blaze rods; bastion types — housing (the consistent one, 12 gold blocks), bridge, treasure (a magma cube spawner), stables (the luck-dependent one, hoglins)
- places — buried treasure (chunk 9,9), shipwreck, magma ravine, ruined portal, desert temple (TNT under a pressure plate), village, ocean monument; the hypermodern route is shipwreck, magma ravine, buried treasure

Hard rule: a place, structure or technique may appear in the hook ONLY if it is listed under "What happened in this run" below. Don't mention anything that didn't happen in the run.

Other hard rules:
- NOTHING about what happens during the race: no lead, gap, swing, death, hearts, comeback, overtake, reset, a split reached, a time or who wins. Only the matchup, the two people racing, or the run's own setting/technique.
- No digits, unless you are told the race was decided by under a second.
- Never name either runner or give one a nickname, label or epithet.
- Fresh: never reuse an idea from the recent titles or the hooks already used, both listed below.
- ALL CAPS, at most the character budget given.

Each option is one of four styles: meme (a trending community joke, from the list below if one is given and fits), tech (a pun on real speedrun technique or gameplay), setting (a tease built from the seed/bastion/world alone), tease (a plain, honest line that leans on none of those). Never force a meme or a technique that is not in "What happened in this run" — a setting or tease option is always safe.

Answer with ${ASK_FOR} options, one per line, each as STYLE|TITLE (e.g. "tech|BLIND DATE AT THE BRIDGE") — nothing else.`;

function titlePrompt(input: {
  facts: readonly string[];
  videoShows: readonly string[];
  memes: readonly TitleMeme[];
  closeMs: number | null;
  hookMax: number;
  pastTitles: readonly string[];
  existingHooks: readonly string[];
  rival: boolean;
  meetings: number;
}): string {
  return `What happened in this run, plain facts only — nothing here says who did it first, who is ahead, or when: ${input.facts.length > 0 ? input.facts.join("; ") : "nothing beyond the race itself"}.
${
  input.videoShows.length > 0
    ? `What the video shows (the operator's own notes on the moment it picked — never let these reveal who is ahead, who wins, or a time):\n${input.videoShows.map((l) => `- ${l}`).join("\n")}\n`
    : ""
}${
    input.memes.length > 0
      ? `This week's community memes — optional, use one only if it truly fits the run facts above, never force it:\n${input.memes.map((m) => `- ${m.name}: ${m.body}`).join("\n")}\n`
      : ""
  }Decided by under a second: ${input.closeMs !== null ? `yes, ${input.closeMs} ms — a number is allowed` : "no — do not use any digits"}
Character budget: ${input.hookMax}
${
  input.rival
    ? input.meetings > 0
      ? "These two have raced each other before on this channel — a rematch/again joke is fine, as long as it is not one already used below."
      : "These two have never met on this channel before."
    : "These two are not a tracked rivalry on this channel — no rematch, again, or 'round two' joke."
}
${
  input.pastTitles.length > 0
    ? `The channel's recent titles, for style only — never reuse one of these ideas:\n${input.pastTitles.map((t) => `- ${t}`).join("\n")}`
    : ""
}
${
  input.existingHooks.length > 0
    ? `Hooks already used on this channel, or already offered for another match — never reuse one of these, or anything close to it:\n${input.existingHooks.map((h) => `- ${h}`).join("\n")}`
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

/**
 * "STYLE|TITLE" per line. A line with no recognised style — no "|" at all, or a word in front of
 * one that is not in `MODEL_STYLES` — keeps its text and falls back to "tease", the catch-all:
 * a formatting slip costs a style tag, never the option itself.
 */
export function parseStyledLines(text: string): Array<{ style: TitleStyle; text: string }> {
  return parseLines(text).map((line) => {
    const at = line.indexOf("|");
    if (at < 0) return { style: "tease", text: line };
    const style = line.slice(0, at).trim().toLowerCase();
    const rest = line.slice(at + 1).trim();
    return { style: (MODEL_STYLES.has(style) ? style : "tease") as TitleStyle, text: rest };
  });
}

/** A chip has no model-given style: the rivalry/close-finish ones read as a tease, the rest
 *  (the seed, a forfeit) as the setting. Blunt on purpose — chips are the fallback path. */
function chipStyle(text: string): TitleStyle {
  return /rematch|1v1 this season|decided by/i.test(text) ? "tease" : "setting";
}

async function buildTitleOptions(matchId: number): Promise<TitleOptions> {
  let match: MatchInfo;
  try {
    match = await getMatch(matchId);
  } catch (err) {
    return {
      options: [],
      source: [],
      styles: [],
      reason: `could not read the match (${describeError(err)})`,
    };
  }
  const [left, right] = match.players;
  if (!left || !right)
    return { options: [], source: [], styles: [], reason: `match ${matchId} has no two players` };

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
  const rival = isRivalPair(left.nickname, right.nickname);

  const options: string[] = [];
  const source: TitleOptions["source"] = [];
  const styles: TitleStyle[] = [];
  /** Populated once there's a model (or chip) call to make — see below; `add()` closes over it. */
  let existingHooks: string[] = [];

  /** Every check a model or chip phrase hook has to pass; the nicknames pair below is operator
   *  grant, not re-checked against any of this. */
  const add = (text: string, from: "model" | "chip", style: TitleStyle): void => {
    if (options.length >= MAX_OPTIONS) return;
    const t = text.trim();
    if (
      titleOptionProblem(t, {
        hookMax,
        players: match.players,
        marginMs,
        rival,
        taken: [...existingHooks, ...options],
      }) !== null
    )
      return;
    options.push(t);
    source.push(from);
    styles.push(style);
  };

  const leftNick = runnerNickname(left.nickname);
  const rightNick = runnerNickname(right.nickname);
  if (leftNick && rightNick) {
    const pair = `${leftNick.toUpperCase()} vs ${rightNick.toUpperCase()}`;
    if (pair.length <= hookMax) {
      options.push(pair);
      source.push("nicknames");
      styles.push("nicknames");
    }
  }

  let reason: string | undefined;
  if (options.length < MAX_OPTIONS) {
    const uploads = await allUploads();
    const pair = [left.nickname, right.nickname].map((n) => titleName(n).toLowerCase());
    const meetings = uploads.filter((u) =>
      pair.every((n) => (u.record.title ?? "").toLowerCase().includes(n)),
    ).length;
    const pastTitles = uploads
      .sort((a, b) => (a.record.uploadedAt < b.record.uploadedAt ? 1 : -1))
      .slice(0, PAST_TITLES)
      .map((u) => u.record.title);
    // Every hook this channel has ever used (any privacy) plus every option already offered to a
    // different match (.telegram.json's titleOffers) — the "never repeat across videos" rule.
    const allHooks = uploads
      .map((u) => splitTitle(u.record.title)?.hook.trim())
      .filter((h): h is string => !!h && !h.includes(HOOK_PLACEHOLDER));
    const offeredElsewhere = Object.entries(readTelegramState().titleOffers)
      .filter(([id]) => Number(id) !== matchId)
      .flatMap(([, o]) => o.options);
    existingHooks = [...new Set([...allHooks, ...offeredElsewhere])];

    const rf = await runFacts(factsId, { match: factsMatch, dir });
    const reply = await runClaude(
      titlePrompt({
        facts: rf.facts,
        videoShows: rf.videoShows,
        memes: titleMemes(),
        closeMs,
        hookMax,
        pastTitles,
        existingHooks,
        rival,
        meetings,
      }),
      { systemPrompt: TITLE_SYSTEM_PROMPT, model: TITLE_MODEL, timeoutMs: 180_000 },
    );
    if (reply.ok) {
      for (const { style, text } of parseStyledLines(reply.text)) add(text, "model", style);
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
    for (const c of buildHookSuggestions(chipInput, 5)) add(c.toUpperCase(), "chip", chipStyle(c));
  }

  return options.length > 0
    ? { options, source, styles, ...(reason ? { reason } : {}) }
    : { options, source, styles, reason: reason ?? "nothing passed the checks for this match" };
}
