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
const { SYNC_SENTENCE_VARIANTS } = await import("./youtubeStore.js");

const FIXTURES = [12730175, 12929221, 12902901, 12898432, 13446429, 13549300, 13448958, 13617328, 13673240];
const fixture = (id: number) =>
  readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const warnings: string[] = [];
console.warn = (line: string) => warnings.push(line);

const ok = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
const failing = () => new Response("{}", { status: 500 });
/** The channel's playlists as `playlists.list` answers them, title to id; each case sets its own. */
let playlists: Record<string, string> = {};
const listed = () =>
  ok({ items: Object.entries(playlists).map(([title, id]) => ({ id, snippet: { title } })) });
/** What the nth `playlists.list` call of a case gets: the list above unless the case says otherwise. */
let onList: (call: number) => Response | Promise<Response> = listed;
let listCalls = 0;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url}`);
  if (url.startsWith("https://oauth2.googleapis.com/")) return ok({ access_token: "t", expires_in: 3600 });
  if (url.includes("/playlists?") && method === "GET") return onList(++listCalls);
  const match = /api\.mcsrranked\.com\/matches\/(\d+)$/.exec(url);
  if (match && FIXTURES.includes(Number(match[1])))
    return ok({ status: "success", data: JSON.parse(fixture(Number(match[1]))) });
  return new Response("not found", { status: 404 });
}) as typeof fetch;
/** A fresh case: the list as it is, no call counted, nothing logged yet. */
const reset = () => {
  onList = listed;
  listCalls = 0;
  warnings.length = 0;
};

const SYNC =
  "both povs are the players own streams, synced on the countdown. if the timer looks off anywhere drop the timestamp here and ill fix it";
const TIP = "tip jar: https://ko-fi.com/x";
const link = (id: string) => `more matches like this: https://www.youtube.com/playlist?list=${id}`;
const lines = async (matchId: number, waitMs?: number) =>
  (await pinnedCommentFor(matchId, waitMs)).split("\n");

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

// Every lookup failing is a log line each, not the end of the chain: the season's id is one this
// process already knows (the case above), so the link is still there.
reset();
onList = failing;
assert.deepEqual(await lines(12898432), [
  "who would you have backed on blind travel, bbiddd or BadGamer?",
  SYNC,
  link("PLSEASON"),
  TIP,
]);
assert.equal(warnings.length, 3, warnings.join("\n"));
assert.ok(warnings.every((w) => w.startsWith('pinned comment, match 12898432: no playlist "')));
assert.ok(warnings[0]!.includes(matchupPlaylistTitle("bbiddd", "BadGamer")));

// The matchup lookup rejects, the player's resolves: the player's is the link.
reset();
playlists = { [playerPlaylistTitle("Infume")]: "PLINFUME" };
onList = (call) => (call === 1 ? failing() : listed());
assert.deepEqual(await lines(13448958), [
  "who would you have backed at the fortress, Infume or bbiddd?",
  SYNC,
  link("PLINFUME"),
  TIP,
]);
assert.equal(warnings.length, 1, warnings.join("\n"));
assert.ok(warnings[0]!.includes(`no playlist "${matchupPlaylistTitle("Infume", "bbiddd")}"`));

// No YouTube sign-in on the box: not a lookup that can only fail.
reset();
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-such-token.json");
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
reset();
assert.deepEqual(await lines(99999999), [SYNC, link("PLSEASON"), TIP]);
assert.match(warnings[0]!, /pinned comment, match 99999999: no question/);

// The kit does not wait on a lookup YouTube never answers: with a cap the comment comes back without
// the link, saying so; without one (the finish step) it would wait as long as the call takes.
reset();
onList = () => new Promise<Response>(() => {});
const started = Date.now();
assert.deepEqual(await lines(13617328, 150), [
  "who would you have backed at the stronghold, nolqndo or thecamo6?",
  SYNC,
  TIP,
]);
assert.ok(Date.now() - started < 5000, "it answered rather than hung");
assert.equal(warnings.length, 1, warnings.join("\n"));
assert.match(warnings[0]!, /pinned comment, match 13617328: no playlist link — no answer after 0\.15 s/);

// A lookup that answers only after the cap does not start another for nobody: it was the last (this
// pair's players and matchup are not ids the process knows, so each next title would be a call).
reset();
onList = async () => {
  await delay(300);
  return failing();
};
assert.deepEqual(await lines(12902901, 100), [
  "who would you have backed at the bastion, BlazeMind or Aquacorde?",
  SYNC,
  TIP,
]);
await delay(700);
assert.ok(listCalls <= 1, `${listCalls} lookups, past the point anyone was waiting`);

// copyVariety (6 Oct 2026): off (default, above) is always SYNC, whatever the match id. On
// picks one of SYNC_SENTENCE_VARIANTS by match id, the same one every time.
reset();
playlists = {
  [matchupPlaylistTitle("edcr", "doogile")]: "PLPAIR",
  [playerPlaylistTitle("edcr")]: "PLEDCR",
  "MCSR Ranked matches": "PLSEASON",
};
const idx = 12730175 % SYNC_SENTENCE_VARIANTS.length;
assert.notEqual(idx, 0, "the fixture must exercise a non-canonical variant");
config.copyVariety = true;
try {
  const withVariety = await lines(12730175);
  assert.deepEqual(withVariety, [
    "who would you have backed on blind travel, edcr or doogile?",
    SYNC_SENTENCE_VARIANTS[idx]!,
    link("PLPAIR"),
    TIP,
  ]);
  assert.notEqual(SYNC_SENTENCE_VARIANTS[idx], SYNC, "must actually differ from the canonical line");
  assert.deepEqual(await lines(12730175), withVariety, "the same match id picks the same variant again");
} finally {
  config.copyVariety = false;
}
assert.deepEqual((await lines(12730175))[1], SYNC, "off again is the canonical line");

console.log("pinnedComment: all checks passed");
