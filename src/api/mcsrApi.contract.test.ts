// Contract tests for `parseMatchId` (src/api/mcsrApi.ts), the one parser behind every match
// command's first argument and the dashboard's match lookups — written from the docs first.
//
// Promises the docs make (README "Commands accept a match id or a match page URL."; CLAUDE.md
// Commands table: `<matchId>` everywhere; the match page is https://mcsrranked.com/matches/<id>):
//  1. A bare match id is that id.
//  2. A match page URL is the id it names — with or without a trailing slash, a query string or
//     a #fragment (what a browser's address bar hands over when copied mid-page).
//  3. Leading zeros do not make a different match.
//  4. Something with no trailing number is refused with an error naming the input.
//  5. Anything ending in digits is read as that id (README: flags after the id, an MCSR Ranked
//     match, not a Twitch link).
//
// Pure function: no network, no files. Run: npx tsx src/api/mcsrApi.contract.test.ts
import assert from "node:assert/strict";
import { parseMatchId } from "./mcsrApi.js";

const ID = 12730175; // src/fixtures/match-12730175.json, a real ranked match

// Promise 1.
assert.equal(parseMatchId(String(ID)), ID, "a bare id is itself");
assert.equal(
  typeof parseMatchId(String(ID)),
  "number",
  "and a number, so matchDir(<id>) names the directory",
);

// Promise 2: the forms a copied address-bar URL takes.
for (const url of [
  `https://mcsrranked.com/matches/${ID}`,
  `https://mcsrranked.com/matches/${ID}/`,
  `http://mcsrranked.com/matches/${ID}`,
  `https://mcsrranked.com/matches/${ID}?tab=timeline`,
  `https://mcsrranked.com/matches/${ID}#splits`,
  `https://mcsrranked.com/matches/${ID}/?tab=timeline#splits`,
  // The stats site's own match route (linked from the dashboard's suggestion cards).
  `https://mcsrranked.com/stats/matches/${ID}`,
]) {
  assert.equal(parseMatchId(url), ID, `${url} names match ${ID}`);
}
// A query value that is itself a number must not win over the path's id.
assert.equal(parseMatchId(`https://mcsrranked.com/matches/${ID}?page=2`), ID, "the path's id, not ?page=2");
assert.equal(parseMatchId(`https://mcsrranked.com/matches/${ID}#t=95`), ID, "the path's id, not #t=95");
console.log("OK: a bare id and every copied form of a match page URL name the same match");

// Promise 3: an id typed with a leading zero is the same match (and the same directory).
assert.equal(parseMatchId(`0${ID}`), ID);

// Promise 4: refusals name the input, so the operator sees what they pasted.
for (const bad of [
  "",
  "not-a-match",
  "https://mcsrranked.com/matches/",
  "https://mcsrranked.com/stats/doogile",
]) {
  assert.throws(
    () => parseMatchId(bad),
    (err: unknown) =>
      err instanceof Error &&
      /Could not find a match ID/.test(err.message) &&
      err.message.includes(`"${bad}"`),
    `"${bad}" is refused, naming the input`,
  );
}
console.log("OK: input that names no match is refused, quoting it");

// Promise 5 (README): the trailing number of whatever is given is the match id, so flags go after
// the id and a Twitch link is not a match. Pinned so a change to this reading is a deliberate one.
assert.equal(parseMatchId("--seconds=20"), 20, "a flag typed before the id is read as match 20");
assert.equal(
  parseMatchId("https://www.twitch.tv/videos/2245123456"),
  2245123456,
  "a Twitch VOD link is read as its trailing number",
);
console.log("OK: anything ending in digits is read as that id (README: flags after the id)");

console.log("mcsrApi.contract: all checks passed");
