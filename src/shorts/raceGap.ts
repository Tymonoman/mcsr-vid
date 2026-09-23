import type { MatchInfo } from "../api/types.js";
import type { ShortCaption, ShortPick } from "./shortPlan.js";

/**
 * Where the race stands at any moment, from `match.timelines` alone, and the Short's data
 * captions built from it.
 *
 * The race is a ladder of milestones in running order. Whoever has climbed further leads; when
 * both have reached the top rung either has, the gap is how far apart they got there. A caption
 * may say who leads mid-race — that is what a race is — but never the result: nothing here reads
 * `match.result`, and no caption is placed at or after the game is decided (`decidedAtMs`).
 */

type Side = "left" | "right";

export interface Milestone {
  type: string;
  /** For the operator's prompt table. */
  label: string;
  /** "<NICK> …" when a player gets there. */
  arrive: string;
  /** "<NICK> 8 S BEHIND …" */
  behind: string;
  /** "<NICK> FIRST …" */
  first: string;
  /** "<NICK> · …" while a single POV is on screen past it. */
  doing: string;
}

/** The race's rungs, in running order. The dragon is not one: it decides the game. */
export const MILESTONES: readonly Milestone[] = [
  {
    type: "story.enter_the_nether",
    label: "Nether",
    arrive: "IN THE NETHER",
    behind: "INTO THE NETHER",
    first: "INTO THE NETHER",
    doing: "IN THE NETHER",
  },
  {
    type: "nether.find_bastion",
    label: "Bastion",
    arrive: "AT A BASTION",
    behind: "AT THE BASTION",
    first: "TO A BASTION",
    doing: "AT A BASTION",
  },
  {
    type: "nether.find_fortress",
    label: "Fortress",
    arrive: "AT THE FORTRESS",
    behind: "AT THE FORTRESS",
    first: "TO THE FORTRESS",
    doing: "AT THE FORTRESS",
  },
  {
    type: "projectelo.timeline.blind_travel",
    label: "Blind",
    arrive: "GOES BLIND",
    behind: "ON BLIND TRAVEL",
    first: "TO GO BLIND",
    doing: "BLIND TRAVEL",
  },
  {
    type: "story.follow_ender_eye",
    label: "Stronghold",
    arrive: "IN THE STRONGHOLD",
    behind: "AT THE STRONGHOLD",
    first: "TO THE STRONGHOLD",
    doing: "IN THE STRONGHOLD",
  },
  {
    type: "story.enter_the_end",
    label: "End",
    arrive: "IN THE END",
    behind: "INTO THE END",
    first: "INTO THE END",
    doing: "IN THE END",
  },
];

export const DEATH_TYPES = new Set(["projectelo.timeline.death", "projectelo.timeline.death_spawnpoint"]);
const DRAGON_DEATH = "projectelo.timeline.dragon_death";

/** Closer than this at the last rung both reached is a dead heat as far as a caption is concerned. */
const NECK_AND_NECK_MS = 1500;
/** A caption line's budget: it has to read at a glance on a phone. */
export const CAPTION_MAX_CHARS = 32;
/** The hook owns the first four seconds of the Short; the race captions start after it. */
export const FIRST_CAPTION_MS = 4000;

/**
 * When the game is decided: its first dragon death (the result lands a fixed 10 s later), or,
 * for a run nobody finished, the forfeit at `result.time`. Null when neither is known.
 */
export function decidedAtMs(match: MatchInfo): number | null {
  const dragons = match.timelines.filter((e) => e.type === DRAGON_DEATH).map((e) => e.time);
  if (dragons.length > 0) return Math.min(...dragons);
  return match.result.time > 0 ? match.result.time : null;
}

const sideOf = (match: MatchInfo, uuid: string): Side | null =>
  uuid === match.players[0]?.uuid ? "left" : uuid === match.players[1]?.uuid ? "right" : null;

/** When each side first reached each milestone, indexed like MILESTONES. */
function arrivals(match: MatchInfo): Array<Partial<Record<Side, number>>> {
  const out = MILESTONES.map((): Partial<Record<Side, number>> => ({}));
  for (const e of match.timelines) {
    const i = MILESTONES.findIndex((m) => m.type === e.type);
    const side = sideOf(match, e.uuid);
    if (i < 0 || !side) continue;
    if (out[i]![side] === undefined || e.time < out[i]![side]!) out[i]![side] = e.time;
  }
  return out;
}

export interface RaceState {
  /** The highest rung either player has reached by then; null while both are in the Overworld. */
  milestone: Milestone | null;
  /** Who has climbed further, or got to the top rung first. */
  leader: Side | null;
  /** How far apart they reached `milestone`; null while only the leader has. */
  gapMs: number | null;
  /** Each side's highest rung by then, or null. */
  at: Record<Side, Milestone | null>;
}

/** The race at `atMs` on the match clock. */
export function raceStateAt(match: MatchInfo, atMs: number): RaceState {
  const reached = arrivals(match);
  const top = (side: Side): number => {
    for (let i = MILESTONES.length - 1; i >= 0; i--) if ((reached[i]![side] ?? Infinity) <= atMs) return i;
    return -1;
  };
  const l = top("left");
  const r = top("right");
  const at = { left: MILESTONES[l] ?? null, right: MILESTONES[r] ?? null };
  const i = Math.max(l, r);
  if (i < 0) return { milestone: null, leader: null, gapMs: null, at };
  if (l !== r) return { milestone: MILESTONES[i]!, leader: l > r ? "left" : "right", gapMs: null, at };
  const tl = reached[i]!.left!;
  const tr = reached[i]!.right!;
  return { milestone: MILESTONES[i]!, leader: tl <= tr ? "left" : "right", gapMs: Math.abs(tl - tr), at };
}

/** "0.3 S", "14 S", "2:11". */
export function formatGap(ms: number): string {
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)} S`;
  if (s < 60) return `${Math.round(s)} S`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The first line that fits the caption budget, or the last one cut to it. */
const fit = (...lines: string[]): string =>
  lines.find((l) => l.length <= CAPTION_MAX_CHARS) ??
  lines[lines.length - 1]!.slice(0, CAPTION_MAX_CHARS).trimEnd();

/**
 * The Short's data captions, `atMs` into the Short. The first, at 4 s when the hook gives way,
 * states the race as it stands then (anything in the hook's four seconds folded in): the gap at
 * the last rung both reached, "NECK AND NECK", or — a single POV — what that player is doing.
 * Then one per milestone or death inside the window, of the players on screen, up to the moment
 * the game is decided and never past it.
 */
export function raceCaptions(match: MatchInfo, pick: ShortPick): ShortCaption[] {
  const [l, r] = match.players;
  if (!l || !r) return [];
  const nick = { left: l.nickname.toUpperCase(), right: r.nickname.toUpperCase() };
  const other = (s: Side): Side => (s === "left" ? "right" : "left");
  const firstAt = pick.startMs + FIRST_CAPTION_MS;
  const decided = decidedAtMs(match) ?? Infinity;
  if (firstAt >= Math.min(pick.endMs, decided)) return [];

  const state = raceStateAt(match, firstAt);
  let opening: ShortCaption;
  if (pick.pov !== "both") {
    const where = state.at[pick.pov];
    opening = {
      atMs: FIRST_CAPTION_MS,
      text: fit(`${nick[pick.pov]} · ${where?.doing ?? "IN THE OVERWORLD"}`, nick[pick.pov]),
      side: pick.pov,
    };
  } else if (!state.milestone || !state.leader) {
    opening = { atMs: FIRST_CAPTION_MS, text: "BOTH STILL IN THE OVERWORLD", side: null };
  } else if (state.gapMs === null) {
    const n = nick[state.leader];
    opening = {
      atMs: FIRST_CAPTION_MS,
      text: fit(`${n} FIRST ${state.milestone.first}`, n),
      side: state.leader,
    };
  } else if (state.gapMs < NECK_AND_NECK_MS) {
    opening = { atMs: FIRST_CAPTION_MS, text: "NECK AND NECK", side: null };
  } else {
    const trailer = other(state.leader);
    const gap = formatGap(state.gapMs);
    opening = {
      atMs: FIRST_CAPTION_MS,
      text: fit(
        `${nick[trailer]} ${gap} BEHIND ${state.milestone.behind}`,
        `${nick[trailer]} ${gap} BEHIND`,
        `${gap} BEHIND ${state.milestone.behind}`,
      ),
      side: trailer,
    };
  }

  const reached = arrivals(match);
  const onScreen = (s: Side) => pick.pov === "both" || pick.pov === s;
  const events: ShortCaption[] = [];
  for (const e of match.timelines) {
    const side = sideOf(match, e.uuid);
    if (!side || !onScreen(side) || e.time <= firstAt || e.time >= pick.endMs || e.time >= decided) continue;
    const at = e.time - pick.startMs;
    if (DEATH_TYPES.has(e.type)) {
      events.push({ atMs: at, text: fit(`${nick[side]} DIES`), side });
      continue;
    }
    const i = MILESTONES.findIndex((m) => m.type === e.type);
    // The first arrival only: a second blind travel is not a new rung.
    if (i < 0 || reached[i]![side] !== e.time) continue;
    const m = MILESTONES[i]!;
    const theirs = reached[i]![other(side)];
    events.push({
      atMs: at,
      text:
        theirs !== undefined && theirs <= e.time
          ? fit(
              `${nick[side]} ${m.arrive} · ${formatGap(e.time - theirs)} APART`,
              `${nick[side]} ${m.arrive}`,
            )
          : fit(`${nick[side]} FIRST ${m.first}`, `${nick[side]} ${m.arrive}`),
      side,
    });
  }
  return [opening, ...events.sort((a, b) => a.atMs - b.atMs)];
}
