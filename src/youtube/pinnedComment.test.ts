// Self-check for pinnedCommentFor: the first comment as it is gathered — a question from the match's
// own race (src/fixtures), the playlist to watch next, every part best effort. Stubs global fetch
// (the MCSR API from the fixtures, YouTube's playlist list and its token endpoint), so nothing hits
// the network. Run: npx tsx src/youtube/pinnedComment.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-pinned-"));
const token = path.join(media, "token.json");
writeFileSync(token, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
process.env.YOUTUBE_TOKEN_FILE = token;

const { config } = await import("../config.js");
config.mediaDir = media;
config.supportUrl = "https://ko-fi.com/x";
config.youtubePlaylistTitle = "MCSR Ranked matches";
const { pinnedCommentFor } = await import("./youtubeUpload.js");
const { matchupPlaylistTitle, playerPlaylistTitle } = await import("./youtube.js");

const FIXTURES = [12730175, 12929221, 12902901, 12898432, 13446429, 13549300];
const fixture = (id: number) =>
  readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8");
const warnings: string[] = [];
console.warn = (line: string) => warnings.push(line);

/** The channel's playlists as `playlists.list` answers them, title to id; each case sets its own. */
let playlists: Record<string, string> = {};
let playlistsDown = false;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url}`);
  const ok = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/")) return ok({ access_token: "t", expires_in: 3600 });
  if (url.includes("/playlists?") && method === "GET") {
    if (playlistsDown) return new Response("{}", { status: 500 });
    return ok({ items: Object.entries(playlists).map(([title, id]) => ({ id, snippet: { title } })) });
  }
  const match = /api\.mcsrranked\.com\/matches\/(\d+)$/.exec(url);
  if (match && FIXTURES.includes(Number(match[1])))
    return ok({ status: "success", data: JSON.parse(fixture(Number(match[1]))) });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const SYNC =
  "both povs are the players own streams, synced on the countdown. if the timer looks off anywhere drop the timestamp here and ill fix it";
const TIP = "tip jar: https://ko-fi.com/x";
const link = (id: string) => `more matches like this: https://www.youtube.com/playlist?list=${id}`;
const lines = async (matchId: number) => (await pinnedCommentFor(matchId)).split("\n");

// The pair's own playlist, when the channel has one: a question, the sync line, the link, the tip jar.
playlists = {
  [matchupPlaylistTitle("edcr", "doogile")]: "PLPAIR",
  [playerPlaylistTitle("edcr")]: "PLEDCR",
  "MCSR Ranked matches": "PLSEASON",
};
assert.deepEqual(await lines(12730175), [
  "who would you have backed on blind travel, edcr or doogile?",
  SYNC,
  link("PLPAIR"),
  TIP,
]);

// A first meeting has no matchup playlist (it waits for the second video) and is not made for the
// comment: the left player's is the link.
playlists = { [playerPlaylistTitle("Feinberg")]: "PLFEIN", "MCSR Ranked matches": "PLSEASON" };
assert.deepEqual(await lines(12929221), [
  "who would you have backed at the bastion, Feinberg or silverrruns?",
  SYNC,
  link("PLFEIN"),
  TIP,
]);

// No playlist of theirs at all: the season's.
playlists = { "MCSR Ranked matches": "PLSEASON" };
assert.deepEqual(await lines(12902901), [
  "who would you have backed at the bastion, BlazeMind or Aquacorde?",
  SYNC,
  link("PLSEASON"),
  TIP,
]);
assert.ok(
  !calls.some((c) => c.startsWith("POST") && c.includes("/youtube/")),
  `nothing is created or added for a comment: ${calls}`,
);

// A joined series holds every game, so it is asked about as a series.
mkdirSync(path.join(media, "13549300"));
writeFileSync(path.join(media, "13549300", "series.json"), "{}");
assert.equal((await lines(13549300))[0], "who do you have taking the series, hackingnoises or BeefSalad?");

// YouTube not answering: no link, and the comment goes up without one, saying so once.
playlistsDown = true;
warnings.length = 0;
assert.deepEqual(await lines(12898432), [
  "who would you have backed on blind travel, bbiddd or BadGamer?",
  SYNC,
  TIP,
]);
assert.equal(warnings.length, 1, warnings.join("\n"));
assert.match(warnings[0]!, /pinned comment, match 12898432: no playlist link/);
playlistsDown = false;

// No YouTube sign-in on the box: not a lookup that can only fail.
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-such-token.json");
warnings.length = 0;
calls.length = 0;
assert.deepEqual(await lines(13446429), [
  "who would you have backed at the stronghold, Infume or Feinberg?",
  SYNC,
  TIP,
]);
assert.ok(!calls.some((c) => c.includes("/playlists?")), "no playlist call without a sign-in");
assert.deepEqual(warnings, []);
process.env.YOUTUBE_TOKEN_FILE = token;

// The MCSR API not answering for a match: no question, and the rest still goes up, season link included.
warnings.length = 0;
assert.deepEqual(await lines(99999999), [SYNC, link("PLSEASON"), TIP]);
assert.match(warnings[0]!, /pinned comment, match 99999999: no question/);

console.log("pinnedComment: all checks passed");
