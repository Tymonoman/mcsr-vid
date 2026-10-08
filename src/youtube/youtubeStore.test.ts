// Self-check for the upload-time text refresh (`uploadTextFor`): a match rendered on an old
// template goes up with today's generated half, while what the operator wrote is kept.
// Run: npx tsx src/youtube/youtubeStore.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  CLOSER,
  CLOSER_VARIANTS,
  LAST_MEETING,
  SUBSCRIBE_LINE,
  SUBSCRIBE_LINE_VARIANTS,
  variantIndex,
} from "../pipeline/description.js";
import {
  lastMeetingFor,
  nicknameWarnings,
  refreshDescription,
  refreshTitle,
  resolveShortVideoId,
  uploadTextFor,
  type UploadRecord,
} from "./youtubeStore.js";
import type { SeriesRecord } from "../playoffs/series.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-uploadtext-"));
config.mediaDir = media;
config.supportUrl = "https://ko-fi.com/x";
config.titleNames = { Pinne: "Skycrab" };

const write = (matchId: number, files: Record<string, string>) => {
  const dir = path.join(media, String(matchId));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
};
const warnings: string[] = [];
console.warn = (line: string) => warnings.push(line);

const OLD_CLOSER = "fan channel, mcsr ranked has no idea i exist. if the sync looks off anywhere say where.";
const oldDescription = [
  "7rowl vs Pinne, mcsr ranked season 11 playoffs, round of 16, game 2. a minecraft speedrun race.",
  "",
  "Season 11 Playoffs, Round of 16 · Game 2 of 5: Pinne (#7 seed, 2477 elo) vs 7rowl (LCQ, 2300 elo).",
  "",
  "0:00 intro",
  "",
  "match page: https://magmamcsr.com/ranked/player/7rowl/matches/101?season=12",
  "all the matches: https://www.youtube.com/playlist?list=PL",
  "",
  OLD_CLOSER,
  "",
  "#MCSRRanked #MCSR #MinecraftSpeedrunning",
].join("\n");

// A playoff game rendered before 22-24 Sept: the old tail, "#7 seed", the old closer, no tip jar,
// the API's spelling in the title and no broadcast spelling in the tags.
write(101, {
  "match-101.title.txt":
    "<HOOK> | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16 · Game 2\n\nguidance",
  "match-101.title.edited.txt":
    "The LCQ vs the 7th seed | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16 · Game 2\n",
  "match-101.description.txt": oldDescription,
  "match-101.tags.txt": "7rowl\nPinne\nmcsr ranked\nminecraft\n",
  "short-101.title.txt": "Can the LCQ take down the 7th seed? #minecraft #mcsr\n",
  "short-101.hook.txt": "Can the LCQ take down the 7th seed?\n",
  "short-101.description.txt": "7rowl vs Pinne. the whole match is on the channel.\n(#7 seed)\n#MCSR",
});
{
  const text = await uploadTextFor(101, "video");
  assert.equal(
    text.title,
    "The LCQ vs the 7th seed | 7rowl vs Skycrab | MCSR Ranked Season 11 Playoffs | Round of 16 | Game 2",
  );
  assert.ok(text.description.includes("Pinne (7th seed, 2477 elo)"), text.description);
  assert.ok(!/#\d+ seed/.test(text.description));
  assert.ok(!text.description.includes(OLD_CLOSER));
  // The tip jar goes where the template puts it: after the links, before the closer.
  assert.ok(
    text.description.includes(
      `all the matches: https://www.youtube.com/playlist?list=PL\ntip jar: https://ko-fi.com/x\n\n${CLOSER}\n`,
    ),
    text.description,
  );
  // The subscribe line is its own paragraph after the opening one, where the template puts it,
  // once; a second refresh of the result changes nothing.
  assert.equal(text.description.split("\n\n")[1], SUBSCRIBE_LINE, text.description);
  assert.equal(text.description.split(SUBSCRIBE_LINE).length, 2, text.description);
  assert.equal(await refreshDescription(text.description, "video"), text.description);
  // The links the render checked are untouched.
  assert.ok(
    text.description.includes("match page: https://magmamcsr.com/ranked/player/7rowl/matches/101?season=12"),
  );
  assert.deepEqual(text.tags, ["7rowl", "Pinne", "Skycrab", "mcsr ranked", "minecraft"]);

  const short = await uploadTextFor(101, "short");
  assert.equal(short.title, "Can the LCQ take down the 7th seed? | 7rowl vs Skycrab #mcsr #minecraft");
  assert.ok(short.description.includes("(7th seed)"));
  assert.ok(!short.description.includes("tip jar"), "a Short's layout gets the seed wording only");
  assert.ok(!short.description.includes(SUBSCRIBE_LINE), "nor the subscribe line");
  assert.deepEqual(warnings, []);
}

// An edited description is the operator's: verbatim, "#9 seed" and all; a ranked title gains
// "| Minecraft Speedrun"; a tip jar already there is not added twice.
write(102, {
  "match-102.title.edited.txt": "Rematch: doogile leads 3-1 | doogile vs Feinberg | MCSR Ranked 1v1\n",
  "match-102.description.txt": "generated\n\ntip jar: https://ko-fi.com/x\n\nfan channel, old.\n",
  "match-102.description.edited.txt": "my own words (#9 seed)\nno tip jar here",
  "match-102.tags.txt": "doogile\nFeinberg\n",
});
{
  const text = await uploadTextFor(102, "video");
  assert.equal(
    text.title,
    "Rematch: doogile leads 3-1 | doogile vs Feinberg | MCSR Ranked 1v1 | Minecraft Speedrun",
  );
  assert.equal(text.description, "my own words (#9 seed)\nno tip jar here");
  assert.deepEqual(text.tags, ["doogile", "Feinberg"]);
}

// A rebuilt title over 100 characters goes up as stored, with one log line.
const longHook = "This hook is long enough to overflow";
const stored = `${longHook} | ab vs cd | MCSR Ranked S11 Playoffs · Round of 16 · Game 2`;
assert.ok(stored.length <= 100);
write(103, { "match-103.title.edited.txt": `${stored}\n` });
{
  const text = await uploadTextFor(103, "video");
  assert.equal(text.title, stored);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /match 103: the stored title goes up as it is — the rebuilt title would be 10\d characters/,
  );
}

// A Short with no saved hook cannot upload, so the kit's read of it keeps the stored title and
// logs nothing (it runs on every match the dashboard opens).
write(104, {
  "match-104.title.edited.txt": "Hook | ab vs cd | MCSR Ranked 1v1 | Minecraft Speedrun\n",
  "short-104.title.txt": "An old Short title #minecraft #mcsr\n",
});
{
  const before = warnings.length;
  assert.equal((await uploadTextFor(104, "short")).title, "An old Short title #minecraft #mcsr");
  assert.equal(warnings.length, before, warnings.slice(before).join("\n"));
}

// A joined series takes the round without a game number; an unknown format half is kept.
assert.equal(
  refreshTitle("Game one | ab vs cd | MCSR Ranked Season 11 Playoffs | Round of 16 | Game 1", true),
  "Game one | ab vs cd | MCSR Ranked Season 11 Playoffs | Round of 16",
);
assert.throws(
  () => refreshTitle("hook | ab vs cd | Some Other Tournament", false),
  /neither a ranked nor a playoff/,
);
// The names are the LAST "a vs b": a hook may read like one.
assert.equal(
  refreshTitle("2699 vs 2376 | ab vs cd | MCSR Ranked 1v1", false),
  "2699 vs 2376 | ab vs cd | MCSR Ranked 1v1 | Minecraft Speedrun",
);
// The spelling that pushes the second name past the mobile cut keeps the stored title.
assert.throws(
  () => refreshTitle("A hook of exactly thirty chars | cdefghij vs Pinne | MCSR Ranked 1v1", false),
  /mobile cut/,
);

// Series refresh: relabelling old "game N" chapters with world seed types, unreadable match leaves
// line unchanged, operator-edited description is kept, and title gains the tail only when it fits.
const mockMatches: Record<number, { seedType?: string | null }> = {
  201: { seedType: "VILLAGE" },
  203: { seedType: "DESERT_TEMPLE" },
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const m = /\/matches\/(\d+)$/.exec(url);
  if (!m) return new Response("not found", { status: 404 });
  const id = Number(m[1]);
  const found = mockMatches[id];
  if (!found) {
    return new Response("network error", { status: 500 });
  }
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        id,
        seedType: found.seedType,
        type: 3,
        season: 12,
        players: [
          { uuid: "u1", nickname: "7rowl" },
          { uuid: "u2", nickname: "Pinne" },
        ],
        timelines: [],
        result: { uuid: "u2", time: 550 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const seriesRecord: SeriesRecord = {
  season: 11,
  slotId: 1,
  round: "Round of 16",
  bestOf: 5,
  firstTo: 3,
  seeds: [
    { uuid: "u1", nickname: "7rowl", label: "LCQ", seasonEloRate: 2300 },
    { uuid: "u2", nickname: "Pinne", label: "#7 seed", seasonEloRate: 2477 },
  ],
  games: [
    { matchId: 201, gameNo: 1, winnerUuid: "u2", durationSec: 600 },
    { matchId: 202, gameNo: 2, winnerUuid: "u1", durationSec: 700 },
    { matchId: 203, gameNo: 3, winnerUuid: "u2", durationSec: 800 },
  ],
  assembledAt: "2026-09-24T10:00:00Z",
};

// 105: old series chapters are relabelled; unreadable match (202) leaves line unchanged;
// title gains " | Minecraft Speedrun" because it fits in 100 characters.
write(105, {
  "series.json": JSON.stringify(seriesRecord),
  "match-105.title.edited.txt": "The series | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16\n",
  "match-105.description.txt": [
    "7rowl vs Pinne, mcsr ranked season 11 playoffs, round of 16, best of 5. every game of the series.",
    "",
    "0:00 game 1",
    "10:00 game 2",
    "21:40 game 3",
    "",
    "game 1: https://magmamcsr.com/ranked/player/7rowl/matches/201?season=12",
    "game 2: https://magmamcsr.com/ranked/player/7rowl/matches/202?season=12",
    "game 3: https://magmamcsr.com/ranked/player/7rowl/matches/203?season=12",
    "bracket: https://magmamcsr.com/ranked/season-11/playoffs",
    "official broadcast: https://twitch.tv/mcsrranked · https://youtube.com/@MCSR_Ranked",
    "",
    OLD_CLOSER,
    "",
    "#MCSRRanked #MCSR #MinecraftSpeedrunning",
  ].join("\n"),
});
{
  const text = await uploadTextFor(105, "video");
  assert.ok(text.description.includes("0:00 game 1 · village seed"), text.description);
  assert.ok(text.description.includes("10:00 game 2"), text.description);
  assert.ok(!text.description.includes("10:00 game 2 ·"), text.description);
  assert.ok(text.description.includes("21:40 game 3 · desert temple seed"), text.description);
  assert.ok(!text.description.includes(OLD_CLOSER));
  assert.ok(text.description.includes(CLOSER));
  assert.ok(text.description.includes("tip jar: https://ko-fi.com/x"));
  assert.equal(
    text.title,
    "The series | 7rowl vs Skycrab | MCSR Ranked Season 11 Playoffs | Round of 16 | Minecraft Speedrun",
  );
  assert.ok(text.title.length <= 100);
}

// 106: an operator-edited description is never touched.
write(106, {
  "series.json": JSON.stringify(seriesRecord),
  "match-106.title.edited.txt": "The series | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16\n",
  "match-106.description.txt": "0:00 game 1\n",
  "match-106.description.edited.txt": "operator edited description\n0:00 game 1\n10:00 game 2\n",
});
{
  const text = await uploadTextFor(106, "video");
  assert.equal(text.description, "operator edited description\n0:00 game 1\n10:00 game 2\n");
}

// 107: title gains the tail only when it fits (<= 100 characters).
write(107, {
  "series.json": JSON.stringify(seriesRecord),
  "match-107.title.edited.txt":
    "A medium series hook | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16\n",
  "match-107.description.txt": "0:00 game 1\n",
});
{
  const text = await uploadTextFor(107, "video");
  assert.equal(
    text.title,
    "A medium series hook | 7rowl vs Skycrab | MCSR Ranked Season 11 Playoffs | Round of 16",
  );
  assert.ok(!text.title.includes("Minecraft Speedrun"));
}

// 108: title does not gain the tail if it already contains "Minecraft".
write(108, {
  "series.json": JSON.stringify(seriesRecord),
  "match-108.title.edited.txt":
    "Minecraft series hook | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16\n",
  "match-108.description.txt": "0:00 game 1\n",
});
{
  const text = await uploadTextFor(108, "video");
  assert.equal(
    text.title,
    "Minecraft series hook | 7rowl vs Skycrab | MCSR Ranked Season 11 Playoffs | Round of 16",
  );
  assert.ok(!text.title.endsWith(" | Minecraft Speedrun"));
}

// Direct checks on refreshDescription.
{
  const sample = [
    "0:00 game 1",
    "12:34 game 2",
    "1:05:40 game 3",
    "1:30:00 game 1 · already has seed",
    "0:00 intro",
  ].join("\n");
  const refreshed = await refreshDescription(sample, "video", undefined, seriesRecord);
  assert.ok(refreshed.includes("0:00 game 1 · village seed"));
  assert.ok(refreshed.includes("12:34 game 2"));
  assert.ok(!refreshed.includes("12:34 game 2 ·"));
  assert.ok(refreshed.includes("1:05:40 game 3 · desert temple seed"));
  assert.ok(refreshed.includes("1:30:00 game 1 · already has seed"));
  assert.ok(refreshed.includes("0:00 intro"));
  // No blank line is no template: there is no opening paragraph to place the subscribe line after.
  assert.ok(!refreshed.includes(SUBSCRIBE_LINE));
}

// --- Earlier uploads: "last time they met" and the nickname check ------------------------------
// Both read the records on disk (`allUploads`): the title each long-form went up under, and when.
const TAIL = "MCSR Ranked 1v1 | Minecraft Speedrun";
const uploaded = (id: number, videoId: string, title: string, over: Partial<UploadRecord> = {}) =>
  write(id, {
    "youtube.json": JSON.stringify({
      videoId,
      uploadedAt: "2026-09-20T19:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: null,
      title,
      ...over,
    } satisfies UploadRecord),
  });
const day = (d: number) => ({ uploadedAt: `2026-09-${String(d).padStart(2, "0")}T19:00:00Z` });
// doogile and Feinberg have met three times: two public, one private with no time yet.
uploaded(301, "AAAAAAAAAAA", `LOVERBOY vs TAS | Infume vs BeefSalad | ${TAIL}`, {
  privacyStatus: "private",
  publishAt: "2026-09-09T19:00:00Z",
});
uploaded(302, "BBBBBBBBBBB", `LOVERBOY vs UNC | Infume vs Feinberg | ${TAIL}`, day(24));
uploaded(303, "CCCCCCCCCCC", `TAS vs UNC | doogile vs Feinberg | ${TAIL}`, day(10));
uploaded(304, "DDDDDDDDDDD", `TAS vs IKEA GUY | doogile vs v_strid | ${TAIL}`, day(19));
uploaded(305, "EEEEEEEEEEE", `TAS vs OG | doogile vs Aquacorde | ${TAIL}`, day(22));
uploaded(306, "FFFFFFFFFFF", `TAS vs DOG | lowkey vs woofdoggo_ | ${TAIL}`, day(25));
uploaded(311, "GGGGGGGGGGG", `Rematch: doogile leads 3-1 | Feinberg vs doogile | ${TAIL}`, day(26));
uploaded(312, "HHHHHHHHHHH", `Another one | doogile vs Feinberg | ${TAIL}`, { privacyStatus: "private" });
// Pinne played under the old spelling, then as Skycrab; the second is a series, scheduled.
uploaded(320, "IIIIIIIIIII", `Hook | Pinne vs Zed | ${TAIL}`, day(14));
uploaded(321, "JJJJJJJJJJJ", "The series | Skycrab vs Zed | MCSR Ranked Season 11 Playoffs | Round of 16", {
  privacyStatus: "private",
  publishAt: "2026-10-02T23:00:00Z",
});
// A Short is not a long-form, and a title with no pair names nobody.
write(322, {
  "youtube-short.json": JSON.stringify({ videoId: "SSSSSSSSSSS", title: "Hook | Pinne vs Zed #mcsr" }),
});
uploaded(330, "KKKKKKKKKKK", "Feinberg on the edcr Situation");

const modern = (matchId: number, pair: string) =>
  [
    `${pair}, mcsr ranked 1v1 on the same seed. a minecraft speedrun race.`,
    "",
    SUBSCRIBE_LINE,
    "",
    "0:00 intro",
    "",
    `match page: https://magmamcsr.com/ranked/player/x/matches/${matchId}?season=12`,
    "all the matches: https://www.youtube.com/playlist?list=PL",
    "tip jar: https://ko-fi.com/x",
    "",
    CLOSER,
    "",
    "#MCSRRanked #MCSR #MinecraftSpeedrunning",
  ].join("\n");
const meeting = (videoId: string) => `${LAST_MEETING}https://youtu.be/${videoId}`;
const linksOf = (description: string) => description.split("\n\n")[3]!.split("\n");

// The most recent earlier meeting, in either order of the two names: not the private one with no
// time, not a later match, not a Short, and the same pair under the old and the new spelling.
write(400, {
  "match-400.title.edited.txt": `Hook | Feinberg vs doogile | ${TAIL}\n`,
  "match-400.description.txt": modern(400, "doogile vs Feinberg"),
});
write(401, {
  "match-401.title.edited.txt": `Hook | doogile vs Feinberg | ${TAIL}\n`,
  "match-401.description.txt": modern(401, "doogile vs Feinberg"),
  "match-401.description.edited.txt": "my own words\nno link here",
});
write(500, {
  "match-500.title.edited.txt": `Hook | Zed vs Pinne | ${TAIL}\n`,
  "match-500.description.txt": modern(500, "Zed vs Skycrab"),
});
write(600, {
  "match-600.title.edited.txt": `Hook | Aa vs Bb | ${TAIL}\n`,
  "match-600.description.txt": modern(600, "Aa vs Bb"),
});
{
  const second = (await uploadTextFor(400, "video")).description;
  assert.deepEqual(linksOf(second), [
    "match page: https://magmamcsr.com/ranked/player/x/matches/400?season=12",
    meeting("GGGGGGGGGGG"),
    "all the matches: https://www.youtube.com/playlist?list=PL",
    "tip jar: https://ko-fi.com/x",
  ]);
  // A retried upload, the kit and the adopt press all ask again: the line is there once.
  assert.equal((await uploadTextFor(400, "video")).description, second);
  assert.equal(second.split(LAST_MEETING).length, 2);
  assert.equal(await refreshDescription(second, "video"), second);
  assert.doesNotMatch(second, /—/, "plain voice, no em dash");

  // The pair's first meeting has no line, and an older match does not point at a newer one.
  assert.ok(!(await uploadTextFor(600, "video")).description.includes(LAST_MEETING));
  assert.ok(!(await uploadTextFor(303, "video")).description.includes(LAST_MEETING), "no earlier game");
  assert.equal(await lastMeetingFor(311, `Hook | doogile vs Feinberg | ${TAIL}`), "CCCCCCCCCCC");
  assert.equal(await lastMeetingFor(303, `Hook | doogile vs Feinberg | ${TAIL}`), null);
  // The operator's own words are theirs.
  assert.equal((await uploadTextFor(401, "video")).description, "my own words\nno link here");

  // Pinne, Pinne's old spelling and a series: the series is the most recent, and one video.
  const third = (await uploadTextFor(500, "video")).description;
  assert.ok(third.includes(meeting("JJJJJJJJJJJ")), third);
  assert.equal(await lastMeetingFor(321, `Hook | Zed vs Pinne | ${TAIL}`), "IIIIIIIIIII");
  // A Short's record (match 322, between the two) never counts.
  assert.ok(!third.includes("SSSSSSSSSSS"));
  assert.equal(await lastMeetingFor(500, "no pair here"), null);
}

// A hook's nickname that earlier titles used beside another player: TAS is doogile's (three
// titles), LOVERBOY Infume's, UNC Feinberg's; a warning names who and when, and nothing refuses.
const hookTitle = (hook: string, pair: string) => `${hook} | ${pair} | ${TAIL}`;
{
  const tas = '"TAS" stood for doogile on 2026-09-22 — one nickname per player';
  assert.deepEqual(await nicknameWarnings(hookTitle("LOVERBOY vs TAS", "Infume vs Feinberg"), 400), [tas]);
  // The owner's own match, either side of the pair, is clean; so is a hook with no nickname.
  assert.deepEqual(await nicknameWarnings(hookTitle("TAS vs UNC", "doogile vs Feinberg"), 400), []);
  assert.deepEqual(await nicknameWarnings(hookTitle("UNC vs TAS", "Feinberg vs doogile"), 400), []);
  assert.deepEqual(
    await nicknameWarnings(hookTitle("Down to the last heart", "Infume vs Feinberg"), 400),
    [],
  );
  // Case does not make a new nickname; a hook with a label in front is read from its "vs" segment.
  assert.deepEqual(await nicknameWarnings(hookTitle("tas vs UNC", "Infume vs Feinberg"), 400), [
    '"tas" stood for doogile on 2026-09-22 — one nickname per player',
  ]);
  assert.equal(
    (await nicknameWarnings(hookTitle("PLAYOFFS | TAS vs UNC", "Infume vs Feinberg"), 400)).length,
    1,
  );
  // After a single earlier title its two players tie: either one in the match will do.
  assert.deepEqual(await nicknameWarnings(hookTitle("WASHED vs IKEA GUY", "Infume vs Feinberg"), 400), [
    '"IKEA GUY" stood for doogile or v_strid on 2026-09-19 — one nickname per player',
  ]);
  assert.deepEqual(
    await nicknameWarnings(hookTitle("WASHED vs IKEA GUY", "silverrruns vs v_strid"), 400),
    [],
  );
  // A match's own record is not earlier.
  assert.deepEqual(await nicknameWarnings(hookTitle("WASHED vs IKEA GUY", "silverrruns vs Zed"), 304), []);
  // The players' own names are no nicknames, nor are figures; a title with no pair has none to check.
  assert.deepEqual(await nicknameWarnings(hookTitle("Infume vs Feinberg", "Infume vs Feinberg"), 400), []);
  assert.deepEqual(await nicknameWarnings(hookTitle("2699 vs 2376", "Infume vs Feinberg"), 400), []);
  assert.deepEqual(await nicknameWarnings("TAS vs UNC", 400), []);
  // Spelling: BEEF sat beside Pinne, then beside Skycrab (one player), and stands for Skycrab.
  uploaded(340, "LLLLLLLLLLL", `BEEF vs HAM | Pinne vs Zed | ${TAIL}`, day(1));
  uploaded(341, "MMMMMMMMMMM", `BEEF vs CAT | Skycrab vs Yan | ${TAIL}`, day(2));
  assert.deepEqual(await nicknameWarnings(hookTitle("BEEF vs X", "Skycrab vs Wil"), 400), []);
  assert.deepEqual(await nicknameWarnings(hookTitle("BEEF vs X", "Zed vs Wil"), 400), [
    '"BEEF" stood for Skycrab on 2026-09-02 — one nickname per player',
  ]);
}

// --- copyVariety (6 Oct 2026): off is byte for byte today's wording; on picks one of a few --
// phrasings by match id, and a repeated upload-text computation (the kit, a retry, the adopt
// route, all of which call uploadTextFor again) must not grow a second copy of either line.
{
  // id 40's closer and subscribe-line indices differ (the independence this fix adds) and both
  // are non-canonical, so the fixture below exercises a distinct variant of each pool, not one
  // shared index (review finding, 7 Oct 2026: both pools used to be keyed off the identical
  // `matchId % 4`).
  const matchId = 40;
  const closerIdx = variantIndex(matchId, 0, CLOSER_VARIANTS.length);
  const subscribeIdx = variantIndex(matchId, 1, SUBSCRIBE_LINE_VARIANTS.length);
  assert.notEqual(closerIdx, 0, "the fixture must exercise a non-canonical closer variant");
  assert.notEqual(subscribeIdx, 0, "the fixture must exercise a non-canonical subscribe variant");
  assert.notEqual(closerIdx, subscribeIdx, "the fixture must show the two pools picking different variants");
  // What `buildDescription` itself would have written to disk for this match rendered with
  // copyVariety on: this match id's own variant of each line, not the canonical text.
  const variantModern = (matchId: number, pair: string) =>
    modern(matchId, pair)
      .replace(SUBSCRIBE_LINE, SUBSCRIBE_LINE_VARIANTS[subscribeIdx]!)
      .replace(CLOSER, CLOSER_VARIANTS[closerIdx]!);
  write(matchId, {
    [`match-${matchId}.title.edited.txt`]: `Hook | Cc vs Dd | ${TAIL}\n`,
    [`match-${matchId}.description.txt`]: variantModern(matchId, "Cc vs Dd"),
  });

  config.copyVariety = true;
  try {
    const text40 = (await uploadTextFor(matchId, "video")).description;
    assert.ok(text40.includes(CLOSER_VARIANTS[closerIdx]!), text40);
    assert.ok(!text40.includes(CLOSER), "replaced by this match's own variant, not the canonical one");
    assert.ok(text40.includes(SUBSCRIBE_LINE_VARIANTS[subscribeIdx]!), text40);
    assert.ok(!text40.includes(SUBSCRIBE_LINE));
    // Exactly one of each paragraph — not the variant plus a second, canonical copy.
    assert.equal(text40.split(CLOSER_VARIANTS[closerIdx]!).length, 2);
    assert.equal(text40.split(SUBSCRIBE_LINE_VARIANTS[subscribeIdx]!).length, 2);

    // Computing the upload text again (every retry and every kit page view does) must be a
    // no-op: before the fix, the subscribe-line check only ever looked for index 0, so a
    // description already carrying a different variant read as "missing it" and gained a
    // second copy on every single call.
    const again = (await uploadTextFor(matchId, "video")).description;
    assert.equal(again, text40, "a second computation changes nothing");
    assert.equal(again.split(SUBSCRIBE_LINE_VARIANTS[subscribeIdx]!).length, 2, "still exactly one copy");
  } finally {
    config.copyVariety = false;
  }

  // Off again: id 700's description, built fresh at render for a match whose template never
  // changes, is byte for byte the same canonical wording as every other match in this file.
  write(700, {
    "match-700.title.edited.txt": `Hook | Aa vs Bb | ${TAIL}\n`,
    "match-700.description.txt": modern(700, "Aa vs Bb"),
  });
  const text700Off = (await uploadTextFor(700, "video")).description;
  assert.ok(text700Off.includes(CLOSER));
  assert.ok(text700Off.includes(SUBSCRIBE_LINE));
  assert.equal(text700Off.split(SUBSCRIBE_LINE).length, 2);
}

// --- resolveShortVideoId (8 Oct 2026, studio "related video" review): refuses a long-form id
// pasted or swapped in where a Short's was expected, instead of silently resolving it as one —
// the mistake `videoIdOwner`'s own doc already names ("the id most likely to be pasted by
// mistake"), the other way round.
{
  const matchId = 900;
  write(matchId, {
    "youtube.json": JSON.stringify({ videoId: "longform900" }),
    "youtube-short.json": JSON.stringify({ videoId: "short900" }),
  });

  assert.deepEqual(await resolveShortVideoId(String(matchId)), { matchId, shortId: "short900" });
  assert.deepEqual(await resolveShortVideoId("short900"), { matchId, shortId: "short900" });

  const wrongKind = await resolveShortVideoId("longform900");
  assert.ok("error" in wrongKind, "a long-form id must not resolve as a Short");
  assert.match((wrongKind as { error: string }).error, /long-form video, not its Short/);

  const unknown = await resolveShortVideoId("not-a-real-id");
  assert.ok("error" in unknown, "an id on no record is an error, not a silent pass-through");

  const noShortYet = 901;
  write(noShortYet, { "youtube.json": JSON.stringify({ videoId: "longform901" }) });
  const missing = await resolveShortVideoId(String(noShortYet));
  assert.ok("error" in missing, "a match id with no Short record yet is an error, not undefined behaviour");
}
console.log("OK: resolveShortVideoId refuses a long-form id where a Short's was expected");

console.log("youtubeStore.test: ok");
