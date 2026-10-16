// Contract test for the rival-post badge, written from the docs, not the code (CLAUDE.md
// "Rival posts", house rule on the YouTube audit; handbook/claude-md-reference.md "Rival posts").
//
// What the docs promise:
//  1. The rivals are `rivalChannelHandle`, a list, default ["mcsrmatches", "mcsr-vault"]; their last
//     uploads are read from the public feed (feeds/videos.xml?channel_id=), the handle resolved off
//     the public channel page, with no token and no Data API call — own channel, own data only.
//  2. A rival post is matched to a card by nickname pair and date — either seating, any case; a
//     rival spelling that differs from the API's ("Lowkey" for lowk3y_) does not match.
//  3. The feed has no lengths, so two matches of one pair in a night both read as posted.
//  4. A posted match sorts after the fresh ones, in the nightly's order too.
//  5. No rival configured, or a feed unreachable: "nothing known", never a reason for the
//     suggestions to fail; refreshed every six hours.
//  6. (16 Oct 2026) Each line says "<channel> posted this match (<date>)" or "<channel> posted this
//     pair: a different match (<date>)"; a match id linked in the description beats the date
//     window; only "this match" moves the card; one line per competitor.
//
// The feeds are saved samples (src/fixtures/rival-feed.xml, @mcsrmatches on 14 Oct 2026;
// rival-feed-mcsr-vault.xml and rival-feed-mcsrreplay.xml, trimmed, 16 Oct 2026), plus synthetic
// entries where a case needs a pair nobody has blocked. fetch is a fake; nothing leaves the process.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/rivalPosts.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import {
  parseRivalFeed,
  refreshRivalPostsIfStale,
  rivalMatchFor,
  rivalPostsSnapshot,
  rivalSightingsFor,
} from "./rivalPosts.js";
import { orderForDisplay, presentSuggestions } from "./suggestPresent.js";
import type { Suggestion } from "./suggest.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-rival-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sample = readFileSync(new URL("../fixtures/rival-feed.xml", import.meta.url), "utf8");
const posts = parseRivalFeed(sample, "mcsrmatches");
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const isMatch = (c: { rivalPosts: { kind: string }[] }) => c.rivalPosts.some((r) => r.kind === "match");
const ids = (cards: readonly { matchId: number }[]) => cards.map((c) => c.matchId);
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
    assert.ok(
      rivalMatchFor(posts, ["silverrruns", "Lowkey"], sec("2026-10-12T18:00:00Z")),
      "sanity: the spelling alone",
    );
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
      "mcsrmatches",
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
    assert.ok(cards.every(isMatch), "both of the night's matches read as posted");
    console.log("OK: without lengths, both matches of a pair's night read as posted");
  }

  // --- 6. This match or only this pair, by the strongest signal each feed carries ----------------
  {
    const replays = parseRivalFeed(fixture("rival-feed-mcsrreplay.xml"), "mcsrreplay");
    const vault = parseRivalFeed(fixture("rival-feed-mcsr-vault.xml"), "mcsr-vault");
    const at = (iso: string) => Date.parse(iso);
    const sight = (feed: typeof posts, matchId: number, players: [string, string], dateSec: number | null) =>
      rivalSightingsFor(feed, { matchId, players, dateSec }, at("2026-10-16T12:00:00Z")).map((x) => x.kind);

    // MCSR Replays links the match page in its description ("MCSR Match Page:
    // https://mcsrranked.com/stats/Infume/9244072"): the id decides, whatever the dates say.
    assert.deepEqual(replays[0]?.matchIds, [9244072], "the id comes off the description");
    assert.deepEqual(
      sight(replays, 9244072, ["silverrruns", "Infume"], sec("2026-01-01T00:00:00Z")),
      ["match"],
      "the linked id is this match, though the post is months after it",
    );
    assert.deepEqual(
      sight(replays, 9244071, ["Infume", "silverrruns"], sec("2026-04-18T10:00:00Z")),
      ["pair"],
      "a post linking another id is the pair only, though it is inside the date window",
    );
    // MCSR Matches and MCSR Vault link no match: the pair and the window after the match decide.
    assert.ok(
      posts.every((p) => (p.matchIds ?? []).length === 0),
      "Matches' descriptions link no match",
    );
    assert.ok(
      vault.every((p) => (p.matchIds ?? []).length === 0),
      "nor do Vault's",
    );
    assert.deepEqual(vault[1]?.players, ["pinne", "anjouu"], "Vault's 'Pinne (Skycrab)' is the API's Pinne");
    assert.deepEqual(
      sight(posts, 1, ["doogile", "Aquacorde"], sec("2026-10-07T12:00:00Z")),
      ["pair"],
      "a match played after the pair's post: the pair only",
    );
    assert.deepEqual(
      sight(posts, 1, ["doogile", "Aquacorde"], sec("2026-09-20T12:00:00Z")),
      ["pair"],
      "a post more than the window after the match: the pair only",
    );
    assert.deepEqual(
      sight(posts, 1, ["doogile", "Feinberg"], sec("2026-10-06T18:30:00Z")),
      [],
      "another pair: nothing",
    );

    // On the cards: two competitors on one card, each its own line, and only "this match" demotes.
    // Vault posted both pairs before these matches were played (22 Aug, 30 Sept): the pair only.
    const played = at("2026-10-02T18:00:00Z");
    const matches = parseRivalFeed(
      "<feed><entry><title>CLOSE ONE | Lowk3y vs Pinne | MCSR Ranked | Minecraft Speedrun</title>" +
        `<published>${new Date(played + DAY).toISOString()}</published></entry></feed>`,
      "mcsrmatches",
    );
    const goats = card(21, ["lowk3y_", "Pinne"], played / 1000);
    const fresh = card(22, ["Pinne", "ANJOUU"], played / 1000);
    const show = (rival: typeof posts) =>
      presentSuggestions([goats, fresh], played + 2 * DAY, rival, [], [], 10_000, null, null);
    assert.deepEqual(ids(show([])), [21, 22], "with no rival, the bigger audience leads");
    const both = show([...vault, ...matches]);
    assert.deepEqual(ids(both), [22, 21], "a posted match goes after the fresh one");
    assert.deepEqual(
      both[1]!.rivalPosts.map((r) => [r.kind, r.label]),
      [
        ["pair", "@mcsr-vault posted this pair: a different match (22 Aug)"],
        ["match", "@mcsrmatches posted this match (3 Oct)"],
      ],
      "one line per competitor, each saying which it did",
    );
    assert.equal(
      both[1]!.rivalPosts[0]!.title,
      "BATTLE of the GOATS | lowk3y_ VS Pinne (Skycrab) | MCSR Ranked 1v1",
    );
    assert.deepEqual(
      both[0]!.rivalPosts.map((r) => r.label),
      ["@mcsr-vault posted this pair: a different match (30 Sept)"],
    );
    assert.deepEqual(
      ids(show(vault)),
      [21, 22],
      "the same pair in another match moves nothing, on either card",
    );
    console.log("OK: this match by id or by pair and date, the pair only otherwise, one line per competitor");
  }

  // --- 1/4/5. The live refresh: public feed, no token, failures read as nothing known -------------
  {
    assert.deepEqual(DEFAULTS.rivalChannelHandle, ["mcsrmatches", "mcsr-vault"]);
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

    config.rivalChannelHandle = [];
    refreshRivalPostsIfStale(T0);
    await settle();
    assert.equal(calls.length, 0, "no rival configured: nothing is fetched");
    config.rivalChannelHandle = ["mcsrmatches"];

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
    assert.match(shown[1]!.rivalPosts[0]?.title ?? "", /Feinberg vs Infume/);
    assert.deepEqual(
      orderForDisplay(list, T0, undefined, [], []).map((s) => s.metrics.matchId),
      [12, 11],
      "in the nightly's order too",
    );
    console.log(
      "OK: the live refresh reads the public feed with no token, and failures read as nothing known",
    );
  }

  // --- 5 with two competitors: one feed failing blanks neither the other nor its own last answer ---
  {
    // Fresh for mcsrmatches alone (read an hour before, at T1 + 6 h above), but the list changed: asked at once.
    const T2 = Date.parse("2026-10-14T19:00:00Z");
    config.rivalChannelHandle = ["mcsrmatches", "@mcsr-vault"];
    let matchesDown = false;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url === "https://www.youtube.com/@mcsr-vault") return new Response("", { status: 503 });
      if (matchesDown) throw new TypeError("fetch failed");
      if (url === "https://www.youtube.com/feeds/videos.xml?channel_id=UCD4mMby1i-Lz2huxfMMWfLA")
        return new Response(sample);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    assert.doesNotThrow(() => refreshRivalPostsIfStale(T2), "a dead feed is not an error");
    await settle();
    assert.ok(
      asked.includes("https://www.youtube.com/@mcsr-vault"),
      "a handle added in Settings is read on the next request",
    );
    assert.equal(rivalPostsSnapshot().length, posts.length, "the live one's posts are known");
    assert.ok(
      rivalPostsSnapshot().every((p) => p.channel === "mcsrmatches"),
      "and nothing from the dead one",
    );
    matchesDown = true;
    refreshRivalPostsIfStale(T2 + 6 * 60_000); // a failure retries within minutes, not hours
    await settle();
    assert.equal(rivalPostsSnapshot().length, posts.length, "a feed that then fails keeps its last answer");
    const shown = presentSuggestions(
      [card(31, ["doogile", "edcr"], (T2 - DAY) / 1000)],
      T2,
      undefined,
      [],
      [],
    );
    assert.deepEqual(shown[0]!.rivalPosts, [], "and a card nobody posted reads as nothing known");
    console.log("OK: with two competitors, a failing feed reads as nothing known and blanks neither");
  }

  console.log("rivalPosts.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
