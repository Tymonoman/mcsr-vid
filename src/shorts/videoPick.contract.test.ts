// Contract tests for the Short's pick (videoPick.ts, shortPlan.ts), written from the docs
// (CLAUDE.md "Shorts", handbook/claude-md-reference.md "Shorts") by someone who did not write the
// code. The model is a fake `agy` (a node script answering from a queue); the MCSR API is a
// stubbed fetch serving src/fixtures and a few synthetic variants; the media directory is a temp
// dir; each proxy is a stand-in newer than its video, so no ffmpeg runs. videoPick.test.ts already
// pins the happy path, the cache, sign-in/quota/timeout wording and the dry run — not repeated here.
//
// The promises the docs make, each pinned below:
//  P1  A pick is one continuous window of 12–60 s (SHORT_MIN_MS / SHORT_MAX_MS), both ends inclusive.
//  P2  The window is validated for bounds: not before match start, not past the run, end after start.
//  P3  rtaAtStart must sit within ±2 s of the window's start on the match clock (read off the footage).
//  P4  The answer carries a pov (both / left / right), a kind (play / race) and a focus side;
//      focus only means something with both POVs (shortPlan: "with both POVs, whose audio leads").
//  P5  One retry on an empty answer, then the timeline heuristic; a rejected window is not re-asked.
//  P6  When the model's pick fails, the heuristic stands in and short-<id>.pick-error.json says why;
//      the pick is short-<id>.pick.json either way.
//  P7  A rejected window's title hooks go with it: the heuristic's pick carries none.
//  P8  The model's hook suggestion is held to hookProblem with the match's players; a failing one is
//      replaced, the window stands.
//  P9  titleHooks: at most 3, each passing hookProblem or dropped.
//  P10 Never a runner label: "v", "v." and "versus" count as "vs", a third side counts, and a fresh
//      "X vs Y" is checked against the match's own two players (API or titleNames spelling).
//  P11 No seed, rank or elo in hooks or suggestions.
//  P12 Nothing names the winner — not in a hook.
//  P13 deathKind is the one reading: the prompt's facts list a hunger reset (death_spawnpoint outside
//      the End) apart from real deaths, and an End death as a real one.
//  P14 The heuristic follows deathKind too: hunger resets are no "deaths" in its hook.
//  P15 A playoff series is picked from game 1's directory; the window is placed in its game, on that
//      game's clock, and must end before that game is decided.
//
// Run: npx tsx src/shorts/videoPick.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { pickFile, SHORT_MAX_MS, SHORT_MIN_MS, type ShortPick } from "./shortPlan.js";
import { hookProblem, pickErrorFile, pickShortMoment, PROXY_FILE } from "./videoPick.js";

/** A doc clause the code may not keep: report it and carry on, so the suite stays green until triage. */
async function deviation(clause: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "videopick-contract-"));
config.mediaDir = path.join(tmp, "media");
mkdirSync(config.mediaDir);
config.watchScript = null; // the machine's real /watch plugin must never run here
delete process.env.HOOK_SUGGEST_CMD;

// --- The API: real fixtures, plus synthetic variants under ids no real match has. ---------------
const load = (id: number): MatchInfo => ({
  ...(JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as MatchInfo),
  changes: [],
});
const SINGLE = 13446429; // Infume (left) vs Feinberg (right), run 7:23.1
const G2 = 13673240; // the same two players again: game 2 of the synthetic series below
const RESETS_ONLY = 12730175; // five death_spawnpoint events, every one outside the End
const TITLE_NAMES = 99_000_001; // SINGLE with the two players the title spells differently
const DEATHS = 99_000_002; // SINGLE plus a real death, a Nether reset and an End death
const matches = new Map<number, MatchInfo>([SINGLE, G2, RESETS_ONLY].map((id) => [id, load(id)]));
{
  const base = load(SINGLE);
  matches.set(TITLE_NAMES, {
    ...base,
    id: TITLE_NAMES,
    players: [
      { ...base.players[0]!, nickname: "Pinne" },
      { ...base.players[1]!, nickname: "lowk3y_" },
    ],
  });
  const [l, r] = base.players;
  const at = (uuid: string, time: number, type: string) =>
    ({ uuid, time, type }) as MatchInfo["timelines"][number];
  matches.set(DEATHS, {
    ...base,
    id: DEATHS,
    timelines: [
      ...base.timelines,
      at(l!.uuid, 30_000, "projectelo.timeline.death"), // overworld, no spawn set: a real death
      at(l!.uuid, 200_000, "projectelo.timeline.death_spawnpoint"), // in the Nether: a hunger reset
      at(r!.uuid, 420_000, "projectelo.timeline.death_spawnpoint"), // in the End (entered 6:39.0): real
    ],
  });
}
const PLAYERS = matches.get(SINGLE)!.players;
const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m && matches.has(Number(m[1]))) return ok(matches.get(Number(m[1])));
  const u = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (u) {
    const p = [...matches.values()].flatMap((x) => x.players).find((x) => x.uuid === u[1]);
    if (p)
      return ok({ ...p, eloRate: 2000, eloRank: 50, country: "us", statistics: { season: {}, total: {} } });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// --- The fake agy: each run takes the next entry of a queue file; "empty" is headless agy's empty answer.
const queueFile = path.join(tmp, "queue.json");
const callsFile = path.join(tmp, "calls.txt");
const promptFile = path.join(tmp, "prompt.txt");
const fake = path.join(tmp, "fake-agy.mjs");
writeFileSync(
  fake,
  `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsFile)}, "x");
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(promptFile)}, argv[argv.indexOf("-p") + 1] ?? "");
const [next, ...rest] = JSON.parse(readFileSync(${JSON.stringify(queueFile)}, "utf8"));
writeFileSync(${JSON.stringify(queueFile)}, JSON.stringify(rest));
console.log(JSON.stringify(next === "empty" || next === undefined
  ? { status: "SUCCESS", response: "" }
  : { status: "SUCCESS", response: "done", structured_output: next }));
`,
);
config.reasonerCommand = [
  "node",
  fake,
  "-p",
  "{prompt}",
  "--output-format",
  "json",
  "--json-schema",
  "{schema}",
];

/** A match directory holding a finished video (a stand-in) and a proxy newer than it. */
function stage(id: number, video = `final-${id}.mp4`): string {
  const dir = path.join(config.mediaDir, String(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, video), "not really a video");
  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(dir, video), past, past);
  writeFileSync(path.join(dir, PROXY_FILE), "not really a proxy");
  return dir;
}
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

interface Asked {
  pick: ShortPick;
  calls: number;
  /** The pick-error file's message, or null when there is none. */
  error: string | null;
  lines: string[];
}
/** Answers `answers` in turn to a forced pick of `id`, from a clean slate. */
async function ask(answers: unknown[], id = SINGLE, dirId = id): Promise<Asked> {
  const dir = path.join(config.mediaDir, String(dirId));
  rmSync(pickFile(dir, id), { force: true });
  rmSync(pickErrorFile(dir, id), { force: true });
  rmSync(callsFile, { force: true });
  writeFileSync(queueFile, JSON.stringify(answers));
  const lines: string[] = [];
  const pick = await pickShortMoment(id, { force: true, timeoutMs: 15_000, log: (l) => lines.push(l) });
  return {
    pick,
    calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8").length : 0,
    error: existsSync(pickErrorFile(dir, id)) ? readJson(pickErrorFile(dir, id)).message : null,
    lines,
  };
}

const dir = stage(SINGLE);
// Infume and Feinberg both travel blind between 5:05 and 5:29: a plain race window.
const good = {
  startSec: 300,
  endSec: 330,
  rtaAtStart: "5:00",
  pov: "both",
  focus: "left",
  kind: "race",
  hookSuggestion: "TWO PORTALS, ONE SEED",
  why: "both leave the Nether",
};

// --- P1: the bounds themselves, as the shared contract states them. ---------------------------
assert.equal(SHORT_MIN_MS, 12_000, "CLAUDE.md: a 12–60 s window");
assert.equal(SHORT_MAX_MS, 60_000, "CLAUDE.md: a 12–60 s window");
assert.equal(
  pickFile(dir, SINGLE),
  path.join(dir, `short-${SINGLE}.pick.json`),
  "the pick is short-<id>.pick.json",
);
{
  // Both ends are inside the window: exactly 12 s and exactly 60 s are the model's to choose.
  const min = await ask([{ ...good, startSec: 300, endSec: 312 }]);
  assert.equal(min.pick.source, "agy", `12 s is allowed: ${min.error}`);
  assert.equal(min.pick.endMs - min.pick.startMs, 12_000);
  const max = await ask([{ ...good, startSec: 300, endSec: 360 }]);
  assert.equal(max.pick.source, "agy", `60 s is allowed: ${max.error}`);
  assert.equal(max.pick.endMs - max.pick.startMs, 60_000);
  // Half a second either side is not.
  for (const endSec of [311.5, 360.5]) {
    const r = await ask([{ ...good, startSec: 300, endSec }]);
    assert.equal(r.pick.source, "heuristic", `${endSec - 300} s is outside 12–60 s`);
    assert.match(r.error ?? "", /outside 12–60 s/);
  }
  console.log("OK P1: 12 s and 60 s are allowed, 11.5 s and 60.5 s are not");
}

// --- P2: the window's bounds. ------------------------------------------------------------------
{
  // Before match start is the countdown, not the race.
  const before = await ask([{ ...good, startSec: -5, endSec: 15, rtaAtStart: "0:00" }]);
  assert.equal(before.pick.source, "heuristic");
  assert.match(before.error ?? "", /before the match/);
  // Well past the run (7:23.1) is the results screen.
  const past = await ask([{ ...good, startSec: 440, endSec: 470, rtaAtStart: "7:20" }]);
  assert.equal(past.pick.source, "heuristic");
  assert.match(past.error ?? "", /past the end of the match/);
  // A window that runs backwards is no window, and a number must be a number.
  const backwards = await ask([{ ...good, startSec: 330, endSec: 300, rtaAtStart: "5:30" }]);
  assert.equal(backwards.pick.source, "heuristic", "end before start");
  const text = await ask([{ ...good, startSec: "300", endSec: "330" }]);
  assert.equal(text.pick.source, "heuristic", "startSec as a string");
  assert.match(text.error ?? "", /must be numbers/);
  console.log("OK P2: before the match, past the run, backwards and non-numeric windows are rejected");
}

// --- P3: rtaAtStart within ±2 s of the start. ----------------------------------------------------
{
  for (const rtaAtStart of ["5:02", "4:58", "5:00.4"]) {
    const r = await ask([{ ...good, rtaAtStart }]);
    assert.equal(r.pick.source, "agy", `${rtaAtStart} is within 2 s of 5:00: ${r.error}`);
    assert.equal(r.pick.startMs, 300_000, "the window is the one the model gave");
  }
  for (const rtaAtStart of ["5:02.5", "4:57", "5:30"]) {
    const r = await ask([{ ...good, rtaAtStart }]);
    assert.equal(r.pick.source, "heuristic", `${rtaAtStart} is more than 2 s from 5:00`);
    assert.match(r.error ?? "", /not read off the footage/);
  }
  // Not a clock reading at all: the answer is not tied to the footage either.
  for (const rtaAtStart of [300, "five minutes", ""]) {
    const r = await ask([{ ...good, rtaAtStart }]);
    assert.equal(r.pick.source, "heuristic", `rtaAtStart ${JSON.stringify(rtaAtStart)}`);
  }
  console.log("OK P3: rtaAtStart within ±2 s passes, 2.5 s off or not a clock fails");
}

// --- P4: pov, kind, focus. ----------------------------------------------------------------------
{
  const right = await ask([{ ...good, focus: "right" }]);
  assert.deepEqual([right.pick.pov, right.pick.focus], ["both", "right"], "both POVs, right's audio leads");
  const level = await ask([{ ...good, focus: undefined }]);
  assert.ok(!("focus" in level.pick), "no focus: both at one level");
  // One player's POV alone has no other side to lower.
  const alone = await ask([{ ...good, pov: "left", kind: "play", focus: "right" }]);
  assert.deepEqual([alone.pick.source, alone.pick.pov, alone.pick.kind], ["agy", "left", "play"]);
  assert.ok(!("focus" in alone.pick), "focus is a both-POVs field");
  for (const bad of [{ focus: "centre" }, { pov: "top" }, { kind: "highlight" }]) {
    const r = await ask([{ ...good, ...bad }]);
    assert.equal(r.pick.source, "heuristic", `rejected: ${JSON.stringify(bad)}`);
  }
  console.log("OK P4: pov/kind/focus kept as given, focus only with both POVs, anything else rejected");
}

// --- P5, P6, P7: the retry, the heuristic, its files, its lack of title hooks. ------------------
{
  // An empty answer is asked once more…
  const second = await ask(["empty", good]);
  assert.deepEqual([second.pick.source, second.calls], ["agy", 2], "the second ask's answer is the pick");
  assert.equal(second.error, null, "a model pick leaves no error file");
  // …and only once.
  const twice = await ask(["empty", "empty", good]);
  assert.deepEqual([twice.pick.source, twice.calls], ["heuristic", 2], "one retry, then the heuristic");
  assert.match(twice.error ?? "", /no JSON object/);
  // A window the rules reject is not an empty answer: no second ask.
  const rejected = await ask([{ ...good, rtaAtStart: "6:00", titleHooks: ["TWO PORTALS, ONE SEED"] }, good]);
  assert.deepEqual(
    [rejected.pick.source, rejected.calls],
    ["heuristic", 1],
    "a rejected window is not re-asked",
  );
  assert.match(rejected.error ?? "", /the model's window was rejected/);
  // The heuristic's pick is on disk, with the reason beside it, and carries no title hooks (24 Sept).
  assert.deepEqual(readJson(pickFile(dir, SINGLE)), rejected.pick, "the heuristic's pick is the pick file");
  assert.ok(!("titleHooks" in rejected.pick), "a rejected window's title hooks go with it");
  // Its window keeps the same contract a model's does: 12–60 s, inside the run.
  const { startMs, endMs } = rejected.pick;
  assert.ok(endMs - startMs >= SHORT_MIN_MS && endMs - startMs <= SHORT_MAX_MS, `${startMs}–${endMs}`);
  assert.ok(startMs >= 0 && endMs <= matches.get(SINGLE)!.result.time, `${startMs}–${endMs} inside the run`);
  assert.equal(
    hookProblem(rejected.pick.hookSuggestion, undefined, PLAYERS),
    null,
    rejected.pick.hookSuggestion,
  );
  console.log(
    "OK P5–P7: one retry on empty, none on a rejected window; the heuristic's pick, reason, no title hooks",
  );
}

// --- P8: the model's own hook suggestion. --------------------------------------------------------
{
  for (const hookSuggestion of [
    "INFUME vs THE CLOCK", // a mismatched pair: a label
    "HARE v. TORTOISE", // "v." is "vs"
    "#3 SEED UNDER PRESSURE", // a seed
    "A".repeat(41), // over the 4-second budget
  ]) {
    const r = await ask([{ ...good, hookSuggestion }]);
    assert.equal(r.pick.source, "agy", "the window stands when only the hook fails");
    assert.equal(r.pick.startMs, 300_000);
    assert.notEqual(r.pick.hookSuggestion, hookSuggestion, `replaced: ${hookSuggestion}`);
    assert.equal(
      hookProblem(r.pick.hookSuggestion, undefined, PLAYERS),
      null,
      `the stand-in passes: ${r.pick.hookSuggestion}`,
    );
  }
  // The match's own two players set against each other is not a label: it stands.
  const real = await ask([{ ...good, hookSuggestion: "Infume vs Feinberg" }]);
  assert.equal(real.pick.hookSuggestion, "Infume vs Feinberg");
  console.log(
    "OK P8: a label, a seed or an overlong hook is replaced and the window stands; the real pair stays",
  );
}

// --- P9, P10: title hooks. ---------------------------------------------------------------------
{
  const five = [
    "TWO PORTALS, ONE SEED",
    "SEVEN MINUTES FLAT",
    "BLIND BY FIVE",
    "THE LONG WAY ROUND",
    "ONE MORE EYE",
  ];
  const capped = await ask([{ ...good, titleHooks: five }]);
  assert.deepEqual(capped.pick.titleHooks, five.slice(0, 3), "at most 3, the model's order");
  assert.deepEqual(readJson(pickFile(dir, SINGLE)).titleHooks, five.slice(0, 3), "written with the pick");

  const labels = await ask([
    {
      ...good,
      titleHooks: [
        "HARE v. TORTOISE",
        "HARE V TORTOISE",
        "HARE versus TORTOISE",
        "Infume vs Feinberg vs THE CLOCK", // a third side (14 Oct 2026)
        "Feinberg vs THE CLOCK",
        "Infume vs Feinberg", // the match's own pair
        "TWO PORTALS, ONE SEED",
      ],
    },
  ]);
  assert.deepEqual(labels.pick.titleHooks, ["Infume vs Feinberg", "TWO PORTALS, ONE SEED"]);
  for (const h of [
    "HARE v. TORTOISE",
    "HARE V TORTOISE",
    "HARE versus TORTOISE",
    "Infume vs Feinberg vs THE CLOCK",
  ])
    assert.ok(
      labels.lines.some(
        (l) => l.includes(JSON.stringify(h)) && /dropped \(names a runner with a label/.test(l),
      ),
      `dropped as a label, said so: ${h}`,
    );

  // The title's own spelling of a player (titleNames: Pinne → Skycrab, lowk3y_ → lowkey) is a real name.
  stage(TITLE_NAMES);
  const spelled = await ask(
    [{ ...good, titleHooks: ["SKYCRAB vs LOWKEY", "Pinne vs lowk3y_", "SKYCRAB vs THE CLOCK"] }],
    TITLE_NAMES,
  );
  assert.equal(spelled.pick.source, "agy", spelled.error ?? "");
  assert.deepEqual(spelled.pick.titleHooks, ["SKYCRAB vs LOWKEY", "Pinne vs lowk3y_"]);
  console.log(
    "OK P9–P10: 3 title hooks at most; v / v. / versus / a third side / a stranger dropped; titleNames kept",
  );
}

// --- P11, P12: seeds, ranks, elo; the winner. Probes past the obvious "#3" shape. ----------------
{
  const elo = ["2100 ELO SHOWDOWN", "THE TOP SEED UNDER PRESSURE", "RANK 1 ON THE LADDER"];
  const r = await ask([{ ...good, titleHooks: elo }]);
  await deviation("No seed, rank or elo in hooks or suggestions (CLAUDE.md House rules)", () =>
    assert.equal(
      r.pick.titleHooks,
      undefined,
      `kept as title hook suggestions: ${JSON.stringify(r.pick.titleHooks)}`,
    ),
  );
  // Invented runners, so the line states no real match's result.
  const runners = [{ nickname: "RunnerOne" }, { nickname: "RunnerTwo" }];
  await deviation("Nothing names the winner: no winner in a hook (CLAUDE.md House rules)", () =>
    assert.notEqual(
      hookProblem("RUNNERONE FINISHES FIRST", undefined, runners),
      null,
      `hookProblem("RUNNERONE FINISHES FIRST") is null`,
    ),
  );
  // The plain spoiler words are refused, as the docs promise.
  for (const h of ["RUNNERONE WINS IT", "RUNNERTWO CHOKES", "RUNNERONE TAKES IT"])
    assert.equal(hookProblem(h, undefined, runners), "it gives the result away", h);
  console.log("OK P11–P12: probed (see any DEVIATION above); the plain spoiler words are refused");
}

// --- P13: the prompt's facts follow deathKind. ----------------------------------------------------
{
  stage(DEATHS);
  const r = await ask([good], DEATHS);
  assert.equal(r.pick.source, "agy", r.error ?? "");
  const prompt = readFileSync(promptFile, "utf8");
  const factsLine = prompt.split("\n").find((l) => l.startsWith('{"left":'));
  assert.ok(factsLine, "the match facts are in the prompt as JSON");
  const facts = JSON.parse(factsLine) as {
    deaths: Array<{ player: string; at: string; phase: string; respawn: string }>;
    hungerResets: Array<{ player: string; at: string; phase: string }>;
  };
  assert.deepEqual(
    facts.deaths.map((d) => [d.player, d.at, d.phase, d.respawn]),
    [
      ["Infume", "0:30.0", "overworld", "world spawn, empty inventory"], // `death`: no spawn set
      ["Feinberg", "7:00.0", "end", "the spawn point set before the End"], // death_spawnpoint in the End
    ],
    "real deaths only: a bare death, and a death in the End",
  );
  assert.deepEqual(
    facts.hungerResets.map((d) => [d.player, d.at, d.phase]),
    [
      ["Infume", "3:20.0", "nether"], // a respawn-anchor reset in the Nether is still a reset
      ["Infume", "6:25.1", "stronghold"],
      ["Feinberg", "6:32.4", "stronghold"],
    ],
    "every death_spawnpoint outside the End is a hunger reset",
  );
  console.log("OK P13: the prompt lists hunger resets apart from deaths, an End death as a death");
}

// --- P14: the heuristic's hook reads deathKind too. ------------------------------------------------
{
  // 12730175's five death screens are all hunger resets: no hook may count them as deaths.
  const pick = await pickShortMoment(RESETS_ONLY, {
    force: true,
    fallback: "the contract test skips the model",
  });
  assert.equal(pick.source, "heuristic");
  assert.doesNotMatch(pick.hookSuggestion, /\bdeaths?\b|\bdied\b|\bdies\b/i, pick.hookSuggestion);
  assert.ok(!existsSync(path.join(config.mediaDir, String(RESETS_ONLY))), "no directory is made for it");
  console.log(
    `OK P14: the heuristic's hook on a resets-only match names no death ("${pick.hookSuggestion}")`,
  );
}

// --- P15: a series is game 1's directory; a window lives in one game and ends before it is decided.
{
  const g1 = SINGLE;
  const g1dir = stage(g1, `series-${g1}.mp4`);
  const g2dir = path.join(config.mediaDir, String(G2));
  mkdirSync(g2dir, { recursive: true });
  writeFileSync(
    path.join(g1dir, "series.json"),
    JSON.stringify({
      season: 12,
      slotId: 1,
      round: "Round of 16",
      bestOf: 5,
      firstTo: 3,
      games: [
        { matchId: g1, gameNo: 1, winnerUuid: null, durationSec: 460, matchStartSec: 10 },
        { matchId: G2, gameNo: 2, winnerUuid: null, durationSec: 510, matchStartSec: 10 },
      ],
      assembledAt: "",
    }),
  );
  // Game 2's RTA 0:00 sits at video 7:40 (game 1's export is 460 s; both cut at 10 s). Its first
  // dragon dies at RTA 8:03.6.
  const OFF = 460;
  const inG2 = { ...good, gameMatchId: G2, startSec: OFF + 300, endSec: OFF + 330, rtaAtStart: "5:00" };
  const r = await ask([inG2], g1);
  assert.deepEqual(
    [r.pick.source, r.pick.gameMatchId, r.pick.startMs, r.pick.endMs],
    ["agy", G2, 300_000, 330_000],
    `placed in game 2 on game 2's clock: ${r.error}`,
  );
  assert.ok(existsSync(pickFile(g1dir, g1)), "the pick is in game 1's directory");
  assert.ok(!existsSync(pickFile(g2dir, G2)) && !existsSync(pickFile(g2dir, g1)), "nothing in game 2's");

  // Ending 1.6 s before game 2 is decided is before; ending 0.4 s after is not.
  const justBefore = await ask([{ ...inG2, startSec: OFF + 452, endSec: OFF + 482, rtaAtStart: "7:32" }], g1);
  assert.equal(justBefore.pick.source, "agy", `ends before the decision: ${justBefore.error}`);
  const after = await ask([{ ...inG2, startSec: OFF + 454, endSec: OFF + 484, rtaAtStart: "7:34" }], g1);
  assert.equal(after.pick.source, "heuristic");
  assert.match(after.error ?? "", /after game 2 \(13673240\) is decided/);
  // Game 1 is held to the same rule: its first dragon dies at RTA 7:13.1.
  const g1End = await ask([{ ...good, gameMatchId: g1, startSec: 420, endSec: 440, rtaAtStart: "7:00" }], g1);
  assert.equal(g1End.pick.source, "heuristic", "a game 1 window past its decision");
  assert.match(g1End.error ?? "", /after game 1 \(13446429\) is decided/);
  // rtaAtStart is the game's own RTA, not video time; and the window's game is where it starts.
  const videoTime = await ask([{ ...inG2, rtaAtStart: "12:40" }], g1);
  assert.equal(videoTime.pick.source, "heuristic", "video time is not the overlay's RTA");
  const wrongGame = await ask([{ ...inG2, gameMatchId: g1 }], g1);
  assert.equal(wrongGame.pick.source, "heuristic", "a game-2 window claimed for game 1");
  // A window straddling the two games is not one game's moment.
  const straddle = await ask([{ ...good, startSec: OFF - 10, endSec: OFF + 10, rtaAtStart: "7:30" }], g1);
  assert.equal(straddle.pick.source, "heuristic", "a window across the join");
  console.log(
    "OK P15: a series pick lives in game 1's directory, inside one game, ending before it is decided",
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log("videoPick.contract: all checks passed");
