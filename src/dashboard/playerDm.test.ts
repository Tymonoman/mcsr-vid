// Self-check for playerDm.ts: the publish kit's DM to a player whose moment the model picked out.
// A temp media dir with the files the route reads (the pick, the export record, series.json); what
// is pinned is the exact text, when a side gets none (the kit's plain line stands), and the `?t=`
// second — the game's match start in the uploaded file plus the moment, rounded down.
// Run: npx tsx src/dashboard/playerDm.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { ANCHOR_SEC } from "../pipeline/kdenliveProject.js";
import type { ShortPick } from "../shorts/shortPlan.js";
import { playerDms } from "./playerDm.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-playerdm-"));
assert.ok(media.startsWith(tmpdir()), "refusing to write outside tmpdir");
config.mediaDir = media;
config.titleNames = { Pinne: "Skycrab", lowk3y_: "lowkey" };

const put = (id: number, file: string, body: unknown) => {
  mkdirSync(matchDir(id), { recursive: true });
  writeFileSync(path.join(matchDir(id), file), JSON.stringify(body));
};
const pick = (id: number, playerMoments?: ShortPick["playerMoments"]): ShortPick => ({
  gameMatchId: id,
  startMs: 300_000,
  endMs: 330_000,
  pov: "both",
  hookSuggestion: "x",
  why: "y",
  kind: "play",
  source: "agy",
  createdAt: "2026-09-30T00:00:00.000Z",
  ...(playerMoments ? { playerMoments } : {}),
});

const VIDEO = "https://youtu.be/dQw4w9WgXcQ";
const NICKS = ["Pinne", "lowk3y_"] as const;
const LEFT_LINE = "You caught the lava sound and dug down to find the hidden portal room";
const RIGHT_LINE = "You traded gold for pearls on your first barter";
const lc = (l: string) => l.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.$/, "");
const ASK =
  "ok if i keep posting your matches? both povs synced, credit and links in the description. say the word and it comes down.";

// One match, no export record: match start is ANCHOR_SEC (10) into the file, and the text is exact.
// 10 + 412.9 = 422.9 — the link says 422, not the nearest second.
put(
  100,
  `short-100.pick.json`,
  pick(100, { left: { atMs: 412_900, line: LEFT_LINE }, right: { atMs: 61_000, line: RIGHT_LINE } }),
);
assert.equal(ANCHOR_SEC, 10, "the arithmetic below is written against a 10 s anchor");
const [left, right] = await playerDms(100, NICKS, VIDEO);
assert.equal(
  left,
  [`hi Pinne, the match against lowk3y_ is up on MCSR Replayoffs: ${VIDEO}?t=422`, lc(LEFT_LINE), ASK].join(
    "\n",
  ),
  "names keep the API spelling; the moment's line is the model's, lowercased, without its full stop",
);
assert.equal(
  right,
  [`hi lowk3y_, the match against Pinne is up on MCSR Replayoffs: ${VIDEO}?t=71`, lc(RIGHT_LINE), ASK].join(
    "\n",
  ),
  "the right side gets the right player's moment",
);
assert.equal(left!.split("\n").length, 3);
assert.ok(left!.includes("say the word and it comes down"), "the takedown offer stays");
assert.ok(!/[!—]/.test(left!.replace(LEFT_LINE, "")), "the operator's own lines have no ! and no em dash");

// An export that cut the countdown's head (`final-<id>.json`): match start is where the record says.
put(
  101,
  `short-101.pick.json`,
  pick(101, { left: { atMs: 412_900, line: LEFT_LINE }, right: { atMs: 61_000, line: RIGHT_LINE } }),
);
put(101, `final-101.json`, { matchStartSec: 6 });
const cut = await playerDms(101, NICKS, VIDEO);
assert.ok(cut[0]!.includes(`${VIDEO}?t=418\n`), "6 + 412.9 -> 418");
assert.ok(cut[1]!.includes(`${VIDEO}?t=67\n`), "6 + 61 -> 67");

// No video on YouTube yet: nothing to link, so neither side has a text and the kit's plain line stands.
assert.deepEqual(await playerDms(100, NICKS, null), [null, null]);

// No pick, a pick with no moments, or only one player's: the other side keeps the plain line.
assert.deepEqual(await playerDms(102, NICKS, VIDEO), [null, null], "no pick file");
put(103, `short-103.pick.json`, pick(103));
assert.deepEqual(await playerDms(103, NICKS, VIDEO), [null, null], "a pick with no playerMoments");
put(104, `short-104.pick.json`, pick(104, { right: { atMs: 61_000, line: RIGHT_LINE } }));
const [none, only] = await playerDms(104, NICKS, VIDEO);
assert.equal(none, null);
assert.ok(only!.startsWith("hi lowk3y_, the match against Pinne is up on MCSR Replayoffs:"));

// A series is game 1's directory and one joined file: a moment of game n is at that game's chapter
// plus its own match start (game 3 has no record of one, so the anchor). Games 900 s and 1000 s long:
// game 2 starts at 900, game 3 at 1900.
put(
  200,
  `short-200.pick.json`,
  pick(200, {
    left: { gameMatchId: 201, atMs: 125_500, line: LEFT_LINE },
    right: { gameMatchId: 202, atMs: 30_000, line: RIGHT_LINE },
  }),
);
put(200, "series.json", {
  games: [
    { matchId: 200, gameNo: 1, durationSec: 900, matchStartSec: 6 },
    { matchId: 201, gameNo: 2, durationSec: 1000, matchStartSec: 10 },
    { matchId: 202, gameNo: 3, durationSec: 800 },
  ],
});
const series = await playerDms(200, NICKS, VIDEO);
assert.ok(series[0]!.includes(`${VIDEO}?t=1035\n`), "900 + 10 + 125.5 = 1035.5 -> 1035");
assert.ok(series[1]!.includes(`${VIDEO}?t=1940\n`), "1900 + 10 + 30 = 1940");

// A moment that cannot be placed in the uploaded file gets no text rather than a wrong second:
// a game the series does not hold, and a game other than the match in a match that is no series.
put(201, `short-201.pick.json`, pick(201, { left: { gameMatchId: 999, atMs: 1_000, line: LEFT_LINE } }));
put(201, "series.json", { games: [{ matchId: 201, gameNo: 1, durationSec: 900 }] });
assert.deepEqual(await playerDms(201, NICKS, VIDEO), [null, null], "a game outside the series");
put(105, `short-105.pick.json`, pick(105, { left: { gameMatchId: 999, atMs: 1_000, line: LEFT_LINE } }));
assert.deepEqual(await playerDms(105, NICKS, VIDEO), [null, null], "a game that is not this match");

// A pick file is on disk and may be hand-edited: a moment without a usable time or line is skipped,
// and a line with a newline in it stays one line.
put(
  106,
  `short-106.pick.json`,
  pick(106, {
    left: { atMs: "soon" as unknown as number, line: LEFT_LINE },
    right: { atMs: 61_000, line: "  You dug down\n  fast  " },
  }),
);
const odd = await playerDms(106, NICKS, VIDEO);
assert.equal(odd[0], null, "atMs that is not a number");
assert.equal(odd[1]!.split("\n")[1], "you dug down fast");
put(107, `short-107.pick.json`, pick(107, { left: { atMs: 61_000, line: "   " } }));
assert.deepEqual(await playerDms(107, NICKS, VIDEO), [null, null], "a blank line");

// A pick torn mid-write by a re-pick is no pick: the kit still loads.
mkdirSync(matchDir(108), { recursive: true });
writeFileSync(path.join(matchDir(108), "short-108.pick.json"), '{"gameMatchId": 108, "playerMo');
assert.deepEqual(await playerDms(108, NICKS, VIDEO), [null, null], "a pick that does not parse");

rmSync(media, { recursive: true, force: true });
console.log("playerDm ok");
