// Self-check for titleOptions.ts's own control flow: the cache contract (so the Telegram message
// and auto-hooks see the same list) and the match-fetch failure path. The model-call branch is
// never exercised here — a cache hit returns before any `getMatch` or `claude` spawn — same
// reasoning as claude.test.ts: no real token spent in a unit test.
// Run: npx tsx src/pipeline/titleOptions.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-titleoptions-"));
config.mediaDir = media;

const unexpected: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  unexpected.push(String(input));
  return new Response("not here", { status: 404 });
}) as typeof fetch;

const { parseStyledLines, runFacts, titleMemes, titleOptionProblem, titleOptions } =
  await import("./titleOptions.js");

const dir = (id: number) => matchDir(id);
const cacheFile = (id: number) => path.join(dir(id), "title-options.json");

// A cache hit is returned verbatim, whatever it holds — no match fetch, no model call.
{
  const id = 1;
  mkdirSync(dir(id), { recursive: true });
  const seeded = { options: ["SKYCRAB vs LOWKEY"], source: ["nicknames"] as const };
  writeFileSync(cacheFile(id), JSON.stringify(seeded));
  const result = await titleOptions(id);
  assert.deepEqual(result, seeded, "a cache hit is returned as-is");
  assert.deepEqual(unexpected, [], "no fetch at all on a cache hit");
}

// A corrupt cache file is treated as missing, not thrown — falls through to a fresh build, which
// fails cleanly here because the match can't be read (fetch answers 404 above).
{
  const id = 2;
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(cacheFile(id), "not json");
  const result = await titleOptions(id);
  assert.deepEqual(result.options, []);
  assert.match(result.reason ?? "", /could not read the match/);
  // The failure is written back to the cache file, so a later non-fresh read sees the same thing
  // rather than retrying every call.
  const cached = JSON.parse(readFileSync(cacheFile(id), "utf8")) as typeof result;
  assert.deepEqual(cached, result, "the failure result is cached too");
}

// `fresh: true` bypasses even a good cache and rebuilds — still a clean failure here, same reason.
{
  const id = 1;
  const result = await titleOptions(id, { fresh: true });
  assert.deepEqual(result.options, []);
  assert.match(result.reason ?? "", /could not read the match/);
}

// runFacts (titles/v2, 18 Oct 2026): seed, bastion and the mapped timeline types, a technique the
// pick confirmed and one only a /watch report's own words turn up — never a decoy chat-*.json,
// which is viewer chat and never reaches a model prompt. death_spawnpoint/dragon_death/
// end.kill_dragon lean on the result and are skipped outright.
{
  const id = 3;
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/match-13549300.json", import.meta.url), "utf8"),
  ) as MatchInfo;
  const matchDirPath = dir(id);
  mkdirSync(path.join(matchDirPath, "short-watch-left"), { recursive: true });
  writeFileSync(
    path.join(matchDirPath, `short-${id}.pick.json`),
    JSON.stringify({
      gameMatchId: id,
      startMs: 0,
      endMs: 20_000,
      pov: "both",
      kind: "race",
      hookSuggestion: "x",
      why: "a routine blind travel into the stronghold",
      source: "agy",
      createdAt: new Date().toISOString(),
      techniques: ["zero-cycle", "boat-clutch"],
      playerMoments: { left: { atMs: 1_000, line: "left's moment" } },
    }),
  );
  writeFileSync(
    path.join(matchDirPath, "short-watch-left", "report.md"),
    "the streamer says the ninjabrain bot call was perfect",
  );
  writeFileSync(
    path.join(matchDirPath, "chat-SomePlayer.json"),
    JSON.stringify([{ text: "glowdar incoming" }]),
  );

  const rf = await runFacts(id, { match: fixture, dir: matchDirPath });
  for (const expected of [
    "village seed",
    "housing bastion",
    "blind travel",
    "bartered with piglins",
    "crying obsidian",
    "a bow",
    "diamonds",
    "armour",
    "the fortress",
    "a bastion",
    "eye throws",
    "the End",
    "educated travel / triangulation / Ninjabrain Bot", // the /watch report's own words
  ])
    assert.ok(
      rf.facts.includes(expected),
      `facts should include ${JSON.stringify(expected)}: ${rf.facts.join(", ")}`,
    );
  assert.ok(!rf.facts.includes("glowdar"), "a decoy chat-*.json must never ground a fact");
  // 19 Oct 2026: the pick's own technique list over-reports (14075056: 12 ids, "blaze-bed" untrue) —
  // it grounds nothing on its own.
  assert.ok(!rf.facts.includes("zero cycle") && !rf.facts.includes("boat clutch"), "pick-only techniques are not facts");
  assert.ok(!rf.facts.some((f) => /dragon/i.test(f)), "dragon_death/end.kill_dragon are skipped, not mapped");
  assert.deepEqual(rf.videoShows, ["a routine blind travel into the stronghold", "left's moment"]);
}

// titleOptionProblem: the trigram repeat check catches an idea reused with different words around
// it ("AIN'T BIG ENOUGH" survives "BRIDGE" becoming "TOWN"), and lets an unrelated hook through.
{
  const players = [{ nickname: "A" }, { nickname: "B" }];
  const base = { hookMax: 60, players, marginMs: null as number | null, rival: false };
  assert.ok(
    titleOptionProblem("THIS BRIDGE AIN'T BIG ENOUGH", { ...base, taken: ["THIS TOWN AIN'T BIG ENOUGH"] }) !==
      null,
    "shares a 3-word run with an existing hook",
  );
  assert.equal(
    titleOptionProblem("A COMPLETELY UNRELATED HOOK", { ...base, taken: ["THIS TOWN AIN'T BIG ENOUGH"] }),
    null,
    "no shared idea passes",
  );
}

// titleOptionProblem: a rematch joke is refused for any pair but the one tracked rivalry.
{
  const base = { hookMax: 60, marginMs: null as number | null, taken: [] as string[] };
  assert.ok(
    titleOptionProblem("WE MEET AGAIN", {
      ...base,
      rival: false,
      players: [{ nickname: "doogile" }, { nickname: "cofesho" }],
    }) !== null,
    "a rematch joke for an untracked pair",
  );
  assert.equal(
    titleOptionProblem("WE MEET AGAIN", {
      ...base,
      rival: true,
      players: [{ nickname: "Feinberg" }, { nickname: "Infume" }],
    }),
    null,
    "allowed for the one tracked rivalry",
  );
}

// runFacts: a death_spawnpoint outside the End reads as "death reset" (deathKind's hungerReset),
// not a plain death word — the operator's own technique list, 18 Oct 2026.
{
  const id = 4;
  const uuid = "deadbeef-0000-0000-0000-000000000000";
  const resetMatch = {
    id,
    players: [{ uuid, nickname: "Someone" }],
    seedType: null,
    bastionType: null,
    timelines: [{ uuid, time: 1_000, type: "projectelo.timeline.death_spawnpoint" }],
  } as unknown as MatchInfo;
  const rf = await runFacts(id, { match: resetMatch, dir: dir(id) });
  assert.deepEqual(rf.facts, ["death reset"]);
}

// titleMemes: only the newest "## Week of …" section's entries, never its "### Rejected" list,
// and nothing from an older week.
{
  const memesFile = path.join(media, "title-memes-fixture.md");
  writeFileSync(
    memesFile,
    [
      "# Title memes",
      "",
      "## Week of 25 Oct 2026",
      "",
      '- **Fresh Meme**: this week\'s joke · source: example.com · title use: "FRESH" · fits when: it fits.',
      "### Rejected",
      "",
      "- **Stale Idea** — not this week's, skip it.",
      "",
      "## Week of 18 Oct 2026",
      "",
      "- **Old Meme**: last week's joke, must not appear.",
    ].join("\n"),
  );
  const memes = titleMemes(memesFile);
  assert.deepEqual(memes, [
    {
      name: "Fresh Meme",
      body: `this week's joke · source: example.com · title use: "FRESH" · fits when: it fits.`,
    },
  ]);
  assert.equal(
    titleMemes(path.join(media, "no-such-file.md")).length,
    0,
    "a missing memes file is no memes, not a failure",
  );
}

// parseStyledLines: "STYLE|TITLE" per line; no "|" or an unrecognised style still keeps the text,
// filed as the "tease" catch-all.
{
  assert.deepEqual(parseStyledLines("tech|BLIND DATE AT THE BRIDGE\nmeme|CHICKEN JOCKEY!!"), [
    { style: "tech", text: "BLIND DATE AT THE BRIDGE" },
    { style: "meme", text: "CHICKEN JOCKEY!!" },
  ]);
  assert.deepEqual(parseStyledLines("A HOOK WITH NO PIPE"), [
    { style: "tease", text: "A HOOK WITH NO PIPE" },
  ]);
  assert.deepEqual(parseStyledLines("notastyle|STILL A HOOK"), [{ style: "tease", text: "STILL A HOOK" }]);
}

console.log("titleOptions: all checks passed");
