// Contract test for the description and the tags (src/pipeline/description.ts), written from the
// docs as an outside engineer would, against real matches in src/fixtures/.
// Run: npx tsx src/pipeline/description.contract.test.ts
//
// What the docs promise (CLAUDE.md House rules / Dashboard / Known pitfalls, the handbook's
// "What the render produces", "Hook chips", "Upload", "Playoffs" and "Publish kit" sections):
//  1. Nothing names the winner: no result line in the description. The text cannot depend on who
//     won, so the same race reads identically whichever side took it, forfeit or not.
//  2. Elo comes from the match, not the user (`eloAtMatchStart`): the rating carried in, never
//     today's live one, and never the change the result caused.
//  3. "a new match every day. subscribe to catch the next one." is its own paragraph, on every
//     video and every series.
//  4. The `/matches/<id>` link is what pairs a Studio upload to its match, so a description always
//     pairs with its own match; a series is game 1's directory and pairs with game 1 first.
//  5. `titleNames` (Pinne -> Skycrab) is the title only: the description keeps the API spelling.
//  6. A playoff game's description prints the round and the game number, never the series score.
//  7. A series' chapters name each game's world ("0:00 game 1 · village seed", `seedPhrase`, as
//     the tags do), never the bracket seed or a score; each game's own split/Result chapters follow
//     its header, offset into the joined video, the whole list kept to YouTube's 10 s minimum.
//  8. A series' description has no score anywhere, and carries the same three hashtags.
//  9. The longest description the channel makes (a best-of-7 series with every chapter, both
//     streams per game, playlist and tip jar) fits YouTube's 5,000 characters, which the upload
//     refuses past.
// 10. Tags: both nicknames first in the API's spelling, then the format words, the world's seed
//     phrase (the same words the series chapters use), each tag at most 30 characters, the list
//     within its budget — and, like the description, the same whoever won.
//
// Already pinned by description.test.ts and not repeated: the exact opening, Show-more length,
// link order, deep-link rounding, the closer, copyVariety, withLastMeeting, the 10 s merge filter
// on synthetic series chapters, tag dedupe and the 30/450 guards on synthetic names.
//
// Limits (no source change to reach further): the series games (7-9) copy writeSeriesText's game
// assembly from src/playoffs/series.ts, `seed: seedPhrase(m)` included, because that function is
// unexported and reads the API (getMatch). So "the world, never the bracket seed" is checked at
// buildSeriesDescription only; series.ts passing the bracket label as `seed` would not fail here.
// Likewise the single-match chapters rebuild pipeline.ts's lead-in
// (`overlayLeadInSec - headTrimSec(introSec)`) rather than run the pipeline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDescription,
  buildSeriesDescription,
  buildTags,
  HASHTAGS,
  seedPhrase,
  SUBSCRIBE_LINE,
  type SeriesDescriptionGame,
} from "./description.js";
import { buildChapters } from "./chapters.js";
import { computeSplits, eloAtMatchStart } from "./overlayProps.js";
import { headTrimSec } from "./exportFast.js";
import { config } from "../config.js";
import { matchPageUrl, playoffsBracketUrl } from "../api/mcsrApi.js";
import { chapterStarts, gameMatchStarts, type SeriesGame } from "../playoffs/series.js";
import { describesMatch, type ChannelVideo } from "../youtube/channelUploads.js";
import type { MatchInfo, UserDetails } from "../api/types.js";
import type { PlayoffContext } from "../playoffs/playoffs.js";
import type { VodWindow } from "./vodAcquisition.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
// The real matches whose API answer carries `changes` (the rest are trimmed fixtures).
const WITH_CHANGES = [13560037, 13673240, 13766294, 13782182];

const userOf = (p: MatchInfo["players"][number], nickname = p.nickname): UserDetails =>
  ({ uuid: p.uuid, nickname, eloRate: p.eloRate }) as UserDetails;
const windowOf = (match: MatchInfo, uuid: string): VodWindow => {
  const vod = match.vod.find((v) => v.uuid === uuid)!;
  return {
    playerUuid: uuid,
    playerNickname: match.players.find((p) => p.uuid === uuid)!.nickname,
    sourceUrl: vod.url,
    path: `/tmp/${uuid}.mp4`,
    matchOffsetIntoVodSec: match.date - vod.startsAt,
    matchOffsetIntoClipSec: 20,
  };
};
/** The description the render writes for `match` (pipeline.ts): the same chapters, the same inputs. */
const render = (match: MatchInfo, over: Partial<Parameters<typeof buildDescription>[0]> = {}) => {
  const [left, right] = match.players;
  return buildDescription({
    matchId: match.id,
    match,
    userLeft: userOf(left!),
    userRight: userOf(right!),
    leftWindow: windowOf(match, left!.uuid),
    rightWindow: windowOf(match, right!.uuid),
    chapters: buildChapters(
      computeSplits(match, left!.uuid, right!.uuid),
      match,
      config.overlayLeadInSec - headTrimSec(config.introSec),
    ),
    playlistUrl: "https://www.youtube.com/playlist?list=PLexample",
    supportUrl: "https://ko-fi.com/example",
    ...over,
  });
};
/** The same race with the other player taking it: same times, same ratings carried in. */
const otherSideWon = (match: MatchInfo, forfeited = match.forfeited): MatchInfo => {
  const winner = match.players.find((p) => p.uuid !== match.result.uuid)!.uuid;
  return {
    ...match,
    forfeited,
    result: { ...match.result, uuid: winner },
    changes: match.changes.map((c) => ({
      ...c,
      change: -c.change!,
      eloRate: c.eloRate! - c.change! + -c.change!,
    })),
  };
};
const video = (description: string) => ({ description }) as ChannelVideo;
/** Win/loss words: any of these in a description is a result line. */
const RESULT_WORDS =
  /\b(?:won|wins?|winner|winning|beats?|beaten|defeat(?:s|ed)?|victory|lost|loses|loser|forfeit(?:s|ed)?|takes it|took it|result:)/i;

// --- 1, 2, 3, 4: a ranked match, from the real API answer ---------------------------------------
for (const id of WITH_CHANGES) {
  const match = load(id);
  const text = render(match);
  const [left, right] = match.players;

  // 1. The description is read before the match is watched: it must read the same whoever won —
  // the cleanest way to show it carries no result, however worded.
  assert.equal(render(otherSideWon(match)), text, `${id}: the description changes with who won`);
  assert.equal(render({ ...match, forfeited: true }), text, `${id}: a forfeit is announced`);
  assert.equal(render(otherSideWon(match, true)), text, `${id}: the other side's forfeit is announced`);
  assert.doesNotMatch(text, RESULT_WORDS, `${id}: a win/loss word in the description`);
  // The finishing time is the result too: "9:31" in the prose would give it away. (The Result
  // chapter is the match-start-offset time of the video, not the RTA, and names nobody.)
  const prose = text
    .split("\n\n")
    .filter((p) => !p.startsWith("0:00"))
    .join("\n\n");
  const rta = `${Math.floor(match.result.time / 60000)}:${String(Math.floor((match.result.time % 60000) / 1000)).padStart(2, "0")}`;
  assert.ok(!prose.includes(rta), `${id}: the finishing time ${rta} is in the description`);

  // 2. The rating each player carried in, never today's live one, never the change.
  const opening = text.split("\n")[0]!;
  for (const p of [left!, right!]) {
    const carried = eloAtMatchStart(match, p.uuid, p.eloRate);
    const change = match.changes.find((c) => c.uuid === p.uuid)!.change!;
    assert.match(
      opening,
      new RegExp(`\\b${p.nickname}\\b[^.]* at ${carried}\\b`),
      `${id}: ${p.nickname}'s match-time elo`,
    );
    if (p.eloRate !== carried)
      assert.ok(!opening.includes(String(p.eloRate)), `${id}: live elo ${p.eloRate} leaked`);
    assert.doesNotMatch(
      text,
      new RegExp(`[+-]${Math.abs(change)}\\b`),
      `${id}: the elo change ±${Math.abs(change)} leaked`,
    );
  }

  // 3. The subscribe ask: its own paragraph, right after the opening, once.
  assert.equal(text.split("\n\n")[1], SUBSCRIBE_LINE, `${id}: subscribe paragraph`);
  assert.equal(text.split(SUBSCRIBE_LINE).length, 2, `${id}: subscribe line once`);

  // 4. A Studio upload of this description pairs back to this match, and to no neighbour id.
  assert.ok(describesMatch(id, video(text)), `${id}: the description does not pair with its match`);
  assert.ok(!describesMatch(Math.floor(id / 10), video(text)), `${id}: pairs with a prefix of its id`);

  // 10. Tags: API spelling first, the world's seed phrase, YouTube's limits — and no result.
  const tags = buildTags(match, userOf(left!), userOf(right!));
  assert.deepEqual(tags.slice(0, 2), [left!.nickname, right!.nickname], `${id}: nicknames lead the tags`);
  assert.ok(tags.includes(seedPhrase(match)!), `${id}: the seed phrase the series chapters also use`);
  assert.ok(
    tags.every((t) => t.length <= 30),
    `${id}: a tag over YouTube's 30`,
  );
  assert.ok(tags.join(",").length <= 450, `${id}: the tag list over its budget`);
  const flipped = otherSideWon(match);
  assert.deepEqual(
    buildTags(flipped, userOf(left!), userOf(right!)),
    tags,
    `${id}: tags change with who won`,
  );
}

// --- 5: titleNames is the title's, not the description's ---------------------------------------
{
  const match = load(13560037);
  const [left, right] = match.players;
  assert.equal(config.titleNames.Pinne, "Skycrab", "DEFAULTS spell Pinne the broadcast's way in titles");
  const text = buildDescription({
    matchId: match.id,
    match,
    userLeft: userOf(left!, "Pinne"),
    userRight: userOf(right!),
    leftWindow: windowOf(match, left!.uuid),
    rightWindow: windowOf(match, right!.uuid),
    chapters: [{ label: "Start", timeSec: 0 }],
  });
  assert.ok(text.startsWith("Pinne vs "), "the description names the player as the API does");
  assert.ok(
    !text.includes("Skycrab"),
    "titleNames is the title only — the description keeps the API spelling",
  );
  assert.ok(
    !buildTags(match, userOf(left!, "Pinne"), userOf(right!)).includes("Skycrab"),
    "render-time tags too",
  );
}

// --- 6: a playoff game: round and game number, never the series score ---------------------------
{
  const match = load(13673240);
  const [left, right] = match.players;
  // Game 5 of 5 at 2-2: the most tempting moment to say so.
  const playoff = {
    season: 11,
    round: "Semifinals",
    gameNo: 5,
    bestOf: 5,
    firstTo: 3,
    score: [2, 2],
    seeds: [
      { uuid: left!.uuid, nickname: left!.nickname, label: "#2 seed", seasonEloRate: 2201 },
      { uuid: right!.uuid, nickname: right!.nickname, label: "#3 seed", seasonEloRate: 2199 },
    ],
  } satisfies PlayoffContext;
  const text = render(match, { playoff });
  const prose = text
    .split("\n\n")
    .filter((p) => !p.startsWith("0:00"))
    .join("\n\n");
  assert.match(text, /semifinals, game 5\./, "the round and the game number are there");
  assert.doesNotMatch(prose, /\b\d\s*(?:[-–:]|to)\s*\d\b/, `a series score in:\n${prose}`);
  assert.doesNotMatch(
    prose,
    /\b(?:tied|leads?|leading|decider|match point|series point)\b/i,
    "a score in words",
  );
  // The going-in score is the overlay's dots, not the text: a different score, the same words.
  assert.equal(
    render(match, { playoff: { ...playoff, score: [0, 2] } }),
    text,
    "the score reaches the description",
  );
}

// --- 7, 8, 9: a series, built the way src/playoffs/series.ts builds one ------------------------
/** Games of a joined series from real matches, each game's export ~ countdown + race + tail. */
const seriesGames = (ids: number[]): SeriesDescriptionGame[] => {
  const matches = ids.map(load);
  const record: SeriesGame[] = matches.map((m, i) => ({
    matchId: m.id,
    gameNo: i + 1,
    winnerUuid: m.result.uuid,
    durationSec: 10 + m.result.time / 1000 + 30,
    matchStartSec: config.introSec + 3,
  }));
  const starts = chapterStarts(record.map((g) => g.durationSec));
  const matchStarts = gameMatchStarts(record);
  return matches.map((m, i) => {
    const [l, r] = m.players;
    return {
      matchId: m.id,
      gameNo: i + 1,
      startSec: starts[i]!,
      seed: seedPhrase(m),
      pageUrl: matchPageUrl(m.id, l!.nickname, m.season),
      streams: m.vod.map((v) => ({
        nickname: m.players.find((p) => p.uuid === v.uuid)!.nickname,
        url: `${v.url}?t=${m.date - v.startsAt}s`,
      })),
      chapters: buildChapters(computeSplits(m, l!.uuid, r!.uuid), m, matchStarts[i]!).slice(1),
    };
  });
};
const seriesText = (ids: number[], bestOf: number) =>
  buildSeriesDescription({
    season: 11,
    round: "Grand Finals",
    bestOf,
    left: { nickname: "Infume", label: "#1 seed", seasonEloRate: 2290 },
    right: { nickname: "Feinberg", label: "LCQ", seasonEloRate: 2140 },
    games: seriesGames(ids),
    bracketUrl: playoffsBracketUrl(11),
    playlistUrl: "https://www.youtube.com/playlist?list=PLexample",
    supportUrl: "https://ko-fi.com/example",
    matchId: ids[0],
  });
const SPLIT_LABELS = new Set([
  "Nether Enter",
  "Bastion",
  "Fortress",
  "Blind",
  "Stronghold Enter",
  "End Enter",
  "Result",
]);
const chapterLinesOf = (text: string) =>
  text
    .split("\n\n")
    .find((p) => p.startsWith("0:00"))!
    .split("\n")
    .map((line) => {
      const [, stamp, label] = /^(\S+) (.+)$/.exec(line)!;
      return { sec: stamp!.split(":").reduce((acc, part) => acc * 60 + Number(part), 0), label: label! };
    });
{
  // Two real Infume–Feinberg games, a best of 3.
  const ids = [13446429, 13673240];
  const text = seriesText(ids, 3);
  const lines = chapterLinesOf(text);

  // 7. Each game's header names its world, the way the tags do.
  assert.equal(lines[0]!.label, "game 1 · buried treasure seed", "game 1's header at 0:00 names its world");
  assert.equal(lines[0]!.sec, 0);
  const game2 = lines.find((l) => l.label.startsWith("game 2"))!;
  assert.equal(game2.label, "game 2 · ruined portal seed");
  for (const id of ids) {
    const tags = buildTags(load(id), userOf(load(id).players[0]!), userOf(load(id).players[1]!));
    assert.ok(tags.includes(seedPhrase(load(id))!), "the chapter's world words are the tags' words");
  }
  // Never the bracket seed or a score in a chapter, however the seeds are labelled.
  for (const { label } of lines) {
    assert.ok(
      /^game \d+ · [a-z ]+ seed$/.test(label) || SPLIT_LABELS.has(label),
      `unexpected chapter "${label}"`,
    );
    assert.doesNotMatch(
      label,
      /#\d|\b\d+(?:st|nd|rd|th)\b|\blcq\b|\d\s*[-–]\s*\d/i,
      `bracket seed or score: "${label}"`,
    );
  }
  // Each game's own chapters follow its header, offset into the joined video: game 2's split
  // chapters land after game 2's header, never before it.
  const game2At = game2.sec;
  const afterHeader = lines.slice(lines.indexOf(game2) + 1);
  assert.ok(afterHeader.length > 0, "game 2 carries its own split chapters");
  assert.ok(
    afterHeader.every((l) => l.sec > game2At),
    "game 2's chapters sit inside game 2",
  );
  // YouTube's rule over the merged list.
  for (let i = 1; i < lines.length; i++)
    assert.ok(lines[i]!.sec - lines[i - 1]!.sec >= 10, "10 s apart, ascending");

  // 3 + 8. The subscribe paragraph, no score, no result, the same three hashtags.
  assert.equal(
    text.split("\n\n")[1],
    SUBSCRIBE_LINE,
    "the subscribe line is its own paragraph on a series too",
  );
  assert.doesNotMatch(text.replace(/^\d+(?::\d{2}){1,2} .*$/gm, ""), /\b\d\s*[-–]\s*\d\b/, "a series score");
  assert.doesNotMatch(text, RESULT_WORDS, "a result word in the series description");
  assert.equal(text.split("\n").at(-1), HASHTAGS.join(" "));
  assert.equal((text.match(/#/g) ?? []).length, 3, "exactly the three hashtags");

  // 4. The series is game 1's directory: game 1's /matches/ link is the first one, so a Studio
  // upload of the series pairs with game 1 before anything else.
  assert.equal(/\/matches\/(\d+)/.exec(text)?.[1], String(ids[0]), "game 1's match link comes first");
  assert.ok(describesMatch(ids[0]!, video(text)));
}
{
  // 9. The longest the channel makes: a best of 7 that went the distance, every game with both
  // streams and its own chapters — past the hour, and still within YouTube's 5,000 characters.
  const ids = [13446429, 13673240, 12929221, 13560037, 13766294, 13782182, 12730175];
  const text = seriesText(ids, 7);
  assert.ok(text.length <= 5000, `${text.length} characters — the upload refuses over 5,000`);
  const lines = chapterLinesOf(text);
  assert.ok(lines.at(-1)!.sec >= 3600, "the fixture runs past the hour");
  assert.match(text, /^\d+:\d{2}:\d{2} /m, "past the hour a chapter reads H:MM:SS");
  for (let i = 1; i < lines.length; i++)
    assert.ok(lines[i]!.sec - lines[i - 1]!.sec >= 10, "10 s apart past the hour too");
  for (let n = 1; n <= 7; n++)
    assert.ok(
      lines.some((l) => l.label.startsWith(`game ${n} · `)),
      `game ${n} keeps its world-named header`,
    );
}

console.log("description.contract: all checks passed");
