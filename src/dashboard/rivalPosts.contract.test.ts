// Contract test for the rival-post badge, written from the docs, not the code (CLAUDE.md
// "Rival posts", house rule on the YouTube audit; handbook/claude-md-reference.md "Rival posts").
//
// What the docs promise:
//  1. The rival is `rivalChannelHandle`, default "mcsrmatches"; its last uploads are read from the
//     public feed (feeds/videos.xml?channel_id=), the handle resolved off the public channel page,
//     with no token and no Data API call — own channel, own data only.
//  2. A rival post is matched to a card by nickname pair and date — either seating, any case; a
//     rival spelling that differs from the API's ("Lowkey" for lowk3y_) does not match.
//  3. The feed has no lengths, so two matches of one pair in a night both read as posted.
//  4. A posted match sorts after the fresh ones, in the nightly's order too.
//  5. No rival configured, or the feed unreachable: "nothing known", never a reason for the
//     suggestions to fail; refreshed every six hours.
//
// The feed is the saved sample (src/fixtures/rival-feed.xml, @mcsrmatches on 14 Oct 2026), plus one
// synthetic entry where a case needs a pair nobody has blocked. fetch is a fake; nothing leaves the process.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/rivalPosts.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import { parseRivalFeed, refreshRivalPostsIfStale, rivalMatchFor, rivalPostsSnapshot } from "./rivalPosts.js";
import { orderForDisplay, presentSuggestions } from "./suggestPresent.js";
import type { Suggestion } from "./suggest.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-rival-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sample = readFileSync(new URL("../fixtures/rival-feed.xml", import.meta.url), "utf8");
const posts = parseRivalFeed(sample);
const sec = (iso: string) => Date.parse(iso) / 1000;

/** A card of two players on a date; everything else equal so only the rival's post can move it. */
const card = (matchId: number, players: [string, string], dateSec: number, popularity = 10): Suggestion => ({
  metrics: {
    matchId,
    players,
    winner: players[0],
    resultMs: 600_000,
    splits: [],
    finishMarginMs: 1_000,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 0,
    maxLeadMs: 0,
    leadChanges: 0,
    panelLeadChanges: 0,
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
  } satisfies MatchMetrics,
  bucket: "close",
  score: 0.5,
  popularity,
  profiles: [
    { nickname: players[0], eloRank: null, elo: null, followers: null },
    { nickname: players[1], eloRank: null, elo: null, followers: null },
  ],
  h2h: null,
  vodUrls: ["a", "b"],
  dateSec,
});

try {
  // --- 2. Matched by pair and date, against the saved feed ---------------------------------------
  {
    // "One Mistake "GG" | Doogile vs Aquacorde | …" went up 6 Oct 21:00 UTC.
    const played = sec("2026-10-06T18:30:00Z");
    assert.match(rivalMatchFor(posts, ["doogile", "Aquacorde"], played)?.title ?? "", /Doogile vs Aquacorde/);
    assert.ok(rivalMatchFor(posts, ["AQUACORDE", "Doogile"], played), "either seating, any case");
    assert.equal(
      rivalMatchFor(posts, ["doogile", "Aquacorde"], sec("2026-10-07T12:00:00Z")),
      null,
      "a match after the post is another match",
    );
    assert.equal(
      rivalMatchFor(posts, ["doogile", "Feinberg"], played),
      null,
      "one of the two is another pair",
    );
    assert.equal(
      posts.find((p) => p.title.startsWith("MINECRAFT"))?.players,
      null,
      "a Short names no pair and matches nothing",
    );
    // A rival spelling that differs from the API's ("Silverrruns vs Lowkey" for lowk3y_, 12 Oct)
    // does not match: titleNames spells our titles only.
    assert.equal(
      rivalMatchFor(posts, ["silverrruns", "lowk3y_"], sec("2026-10-12T18:00:00Z")),
      null,
      "Lowkey is not lowk3y_: that post is not flagged",
    );
    assert.ok(rivalMatchFor(posts, ["silverrruns", "Lowkey"], sec("2026-10-12T18:00:00Z")), "sanity: the spelling alone");
    console.log("OK: matched by pair and date against the saved feed");
  }

  // --- 3. No lengths in the feed: two matches of one pair in a night both read as posted ----------
  {
    const night = Date.parse("2026-10-13T19:00:00Z");
    const feed = parseRivalFeed(
      sample.replace(
        "</feed>",
        "<entry><title>Feinberg vs Infume | MCSR Ranked | Minecraft Speedrun</title>" +
          `<published>${new Date(night + DAY).toISOString()}</published></entry></feed>`,
      ),
    );
    assert.equal(
      feed.find((p) => p.title.startsWith("Feinberg"))?.durationSec,
      undefined,
      "the public feed carries no length",
    );
    const cards = presentSuggestions(
      [card(1, ["Infume", "Feinberg"], night / 1000), card(2, ["feinberg", "infume"], (night + HOUR) / 1000)],
      night + 2 * DAY,
      feed,
      [],
      [],
      10_000,
      null,
      null,
    );
    assert.ok(
      cards.every((c) => c.rivalPosted !== null),
      "both of the night's matches read as posted",
    );
    console.log("OK: without lengths, both matches of a pair's night read as posted");
  }

  // --- 1/4/5. The live refresh: public feed, no token, failures read as nothing known -------------
  {
    assert.equal(DEFAULTS.rivalChannelHandle, "mcsrmatches");
    const T0 = Date.parse("2026-10-14T06:00:00Z");
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let down = true;
    const withFeed = sample.replace(
      "</feed>",
      "<entry><title>GG | Feinberg vs Infume | MCSR Ranked | Minecraft Speedrun</title>" +
        `<published>${new Date(T0 - 6 * HOUR).toISOString()}</published></entry></feed>`,
    );
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
      if (down) throw new TypeError("fetch failed"); // no network
      if (url === "https://www.youtube.com/@mcsrmatches")
        return new Response(
          '<link rel="canonical" href="https://www.youtube.com/channel/UCD4mMby1i-Lz2huxfMMWfLA">',
        );
      if (url === "https://www.youtube.com/feeds/videos.xml?channel_id=UCD4mMby1i-Lz2huxfMMWfLA")
        return new Response(withFeed);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

    config.rivalChannelHandle = "";
    refreshRivalPostsIfStale(T0);
    await settle();
    assert.equal(calls.length, 0, "no rival configured: nothing is fetched");
    config.rivalChannelHandle = DEFAULTS.rivalChannelHandle;

    assert.doesNotThrow(() => refreshRivalPostsIfStale(T0), "no network is not an error");
    await settle();
    assert.equal(calls.length, 1, "one try");
    assert.deepEqual(rivalPostsSnapshot(), [], "and nothing known");
    const list = [
      card(11, ["Infume", "Feinberg"], (T0 - 20 * HOUR) / 1000, 99),
      card(12, ["doogile", "edcr"], (T0 - 20 * HOUR) / 1000),
    ];
    assert.equal(presentSuggestions(list, T0).length, 2, "the cards still come, without badges");

    // The retry interval after a failure is not documented; only that it is no worse than the
    // six-hour refresh.
    down = false;
    const T1 = T0 + 6 * HOUR;
    refreshRivalPostsIfStale(T1);
    for (let i = 0; i < 100 && rivalPostsSnapshot().length === 0; i++) await settle();
    assert.equal(rivalPostsSnapshot().length, posts.length + 1, "a later try reads the whole feed");
    for (const c of calls) {
      assert.ok(c.url.startsWith("https://www.youtube.com/"), `the public site only, no Data API: ${c.url}`);
      assert.ok(
        !Object.keys(c.headers).some((h) => h.toLowerCase() === "authorization"),
        `no token: ${c.url}`,
      );
    }
    const fetched = calls.length;
    refreshRivalPostsIfStale(T1 + 5 * HOUR);
    await settle();
    assert.equal(calls.length, fetched, "fresh for six hours");
    refreshRivalPostsIfStale(T1 + 6 * HOUR);
    await settle();
    assert.ok(calls.length > fetched, "then read again");

    // The badge and the order, from the live snapshot (no rival argument): the posted pair goes after
    // the fresh one though it is the more popular, on the cards and in the nightly's order alike.
    const shown = presentSuggestions(list, T0, undefined, [], []);
    assert.deepEqual(
      shown.map((c) => c.matchId),
      [12, 11],
      "a posted match sorts after the fresh one",
    );
    assert.match(shown[1]!.rivalPosted?.title ?? "", /Feinberg vs Infume/);
    assert.deepEqual(
      orderForDisplay(list, T0, undefined, [], []).map((s) => s.metrics.matchId),
      [12, 11],
      "in the nightly's order too",
    );
    console.log(
      "OK: the live refresh reads the public feed with no token, and failures read as nothing known",
    );
  }

  console.log("rivalPosts.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
