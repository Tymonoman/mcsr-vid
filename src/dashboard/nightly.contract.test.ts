// Contract test for the nightly's blocked-player gate (src/dashboard/nightly.ts), from the docs alone
// (CLAUDE.md "Blocked players", "Nightly", "Tonight's queue"; README; handbook/claude-md-reference.md).
// Promises:
//
//   1. A blocked match is "never rendered by the nightly even if queued — the block outranks the
//      queue, the only gate that does": the queue beats nightlySkip and the known-player gate, never
//      the block.
//   2. With a blocked match at the FRONT of tonight's queue (where Creator watch puts a watched
//      runner's match), the night falls through to the next eligible candidate instead.
//   3. A queued id the ranked list has since dropped is resolved from the API (`resolveQueuedPick`)
//      and still refused when the API's pair is blocked.
//   4. A playoff game always counts as known, but a blocked seed's games are skipped too.
//   5. Any case.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/nightly.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import type { PlayoffBoard } from "../playoffs/playoffs.js";
import {
  nightlyEligible,
  pickNightlyCandidate,
  playoffPicks,
  resolveQueuedPick,
  type NightlyPick,
} from "./nightly.js";

const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  playoffsFirst: config.playoffsFirst,
  favourites: config.favouritePlayers,
  fetch: globalThis.fetch,
};
const media = mkdtempSync(path.join(tmpdir(), "mcsr-nightly-contract-"));
config.mediaDir = media; // no scan cache: an empty pool
config.blockedPlayers = ["aquacorde", "BEEFSALAD"]; // any case, against the API's own spelling
config.favouritePlayers = [...DEFAULTS.favouritePlayers]; // doogile, Feinberg, … — known by being a favourite

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const served = new Map<number, MatchInfo>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const match = m ? served.get(Number(m[1])) : undefined;
  if (!match) throw new Error(`no network in this test: ${url.href}`);
  return new Response(JSON.stringify({ status: "success", data: { ...match, id: Number(m![1]) } }));
}) as typeof fetch;

const pick = (matchId: number, players: [string, string], bucket = "close"): NightlyPick => ({
  metrics: { matchId, players },
  bucket,
});
const night = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 10 };
const vodsReady = async () => true; // the VOD probe is not what is under test

try {
  // --- 1. Queued, a favourite on the other side, and blocked: not eligible -------------------------
  // Aquacorde opposite doogile: a known pair the queue would otherwise wave straight through.
  const blockedKnown = pick(20_000_001, ["doogile", "Aquacorde"]);
  assert.equal(
    await nightlyEligible([20_000_001], vodsReady)(blockedKnown),
    false,
    "queued and known, still blocked",
  );
  // The control: the same pick unblocked is eligible because it is queued (and known).
  const cleanKnown = pick(20_000_002, ["doogile", "Feinberg"]);
  assert.equal(
    await nightlyEligible([20_000_002], vodsReady)(cleanKnown),
    true,
    "the queue's own pick renders",
  );
  // And the queue still beats the known-player gate for a no-name pair — only the block outranks it.
  const noNames = pick(20_000_003, ["nolqndo", "thecamo6"]);
  assert.equal(await nightlyEligible([20_000_003], vodsReady)(noNames), true, "queued no-names render");
  assert.equal(await nightlyEligible([], vodsReady)(noNames), false, "unqueued no-names do not");
  console.log("OK: the block outranks the queue; the queue still outranks the known-player gate");

  // --- 2. Blocked at the front of the queue: the night falls through --------------------------------
  const queue = [20_000_001, 20_000_002];
  const chosen = await pickNightlyCandidate(
    [cleanKnown, blockedKnown],
    { ...night, queue },
    nightlyEligible(queue, vodsReady),
  );
  assert.equal(chosen?.metrics.matchId, 20_000_002, "the blocked front of the queue is passed over");
  // Blocked and alone in the queue and on the list: nothing renders tonight rather than it.
  const nothing = await pickNightlyCandidate(
    [blockedKnown],
    { ...night, queue: [20_000_001] },
    nightlyEligible([20_000_001], vodsReady),
  );
  assert.equal(nothing, null, "a night with only a blocked match renders nothing");
  console.log("OK: a blocked match at the front of tonight's queue is never the night's render");

  // --- 3. A queued id off the list, resolved from the API ------------------------------------------
  served.set(20_000_011, fixture(13549300)); // hackingnoises vs BeefSalad
  served.set(20_000_012, fixture(12902901)); // BlazeMind vs Aquacorde
  served.set(20_000_013, fixture(12730175)); // edcr vs doogile
  assert.equal(await resolveQueuedPick(20_000_011), null, "BeefSalad's match resolves to nothing");
  assert.equal(await resolveQueuedPick(20_000_012), null, "Aquacorde's match resolves to nothing");
  const resolved = await resolveQueuedPick(20_000_013);
  assert.deepEqual(resolved?.metrics.players, ["edcr", "doogile"], "the control resolves to its pair");
  const fellThrough = await pickNightlyCandidate(
    [cleanKnown],
    { ...night, queue: [20_000_011] },
    nightlyEligible([20_000_011], vodsReady),
    resolveQueuedPick,
  );
  assert.equal(
    fellThrough?.metrics.matchId,
    20_000_002,
    "the dropped blocked id is passed over, not rendered",
  );
  console.log("OK: a queued blocked id the list dropped is resolved and still refused");

  // --- 4. Playoffs: always known, never past the block ----------------------------------------------
  config.playoffsFirst = true;
  const board = {
    slots: [
      {
        seeds: [{ nickname: "beefsalad" }, { nickname: "hackingnoises" }],
        games: [{ matchId: 20_000_021, dateSec: 1 }],
      },
      {
        seeds: [{ nickname: "Infume" }, { nickname: "Feinberg" }],
        games: [{ matchId: 20_000_022, dateSec: 2 }],
      },
    ],
  } as unknown as PlayoffBoard;
  const playoffs = await playoffPicks(async () => board);
  assert.deepEqual(
    playoffs.map((p) => p.metrics.matchId),
    [20_000_022],
    "a blocked seed's game is not a playoff candidate, whatever case the bracket spells him in",
  );
  console.log("OK: a blocked seed's playoff games are skipped");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.playoffsFirst = saved.playoffsFirst;
  config.favouritePlayers = saved.favourites;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("nightly.contract: all checks passed");
