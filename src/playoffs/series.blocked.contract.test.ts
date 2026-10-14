// Contract test for the series render's blocked-player gate (`renderSeries`, src/playoffs/series.ts),
// from the docs alone (CLAUDE.md "Blocked players": `POST /api/series/:id/render` refuses before the
// run starts; handbook/claude-md-reference.md: `renderSeries` itself refuses with {kind:"blocked"},
// "the one place both that route and `npm run series` settle through"). Promises:
//
//   1. A blocked runner's series answers { kind: "blocked", matchId } before any game is rendered or
//      exported and before the bracket is read.
//   2. Any case.
// (The control path — a clean series rendering and joining — is pinned by series.test.ts.)
// Run: MCSR_CONFIG=/nonexistent npx tsx src/playoffs/series.blocked.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { renderSeries } from "./series.js";

const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, fetch: globalThis.fetch };
const media = mkdtempSync(path.join(tmpdir(), "mcsr-series-contract-"));
config.mediaDir = media;

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const served = new Map<number, MatchInfo>([
  [10_000_001, fixture(13549300)], // hackingnoises vs BeefSalad
  [10_000_002, fixture(12902901)], // BlazeMind vs Aquacorde
]);
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requests.push(url.href);
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const match = m ? served.get(Number(m[1])) : undefined;
  if (!match) throw new Error(`no network in this test: ${url.href}`);
  return new Response(JSON.stringify({ status: "success", data: { ...match, id: Number(m![1]) } }));
}) as typeof fetch;

const work: string[] = [];
const runners = {
  renderGame: async (id: number) => (work.push(`render ${id}`), null),
  exportGame: async (id: number) => (work.push(`export ${id}`), null),
  log: () => {},
};

try {
  config.blockedPlayers = ["beefsalad", "AQUACORDE"]; // any case
  for (const id of [10_000_001, 10_000_002]) {
    requests.length = 0;
    assert.deepEqual(
      await renderSeries(id, runners),
      { kind: "blocked", matchId: id },
      `#${id} is refused as blocked`,
    );
    assert.deepEqual(
      requests,
      [`https://api.mcsrranked.com/matches/${id}`],
      "no bracket read past the match itself",
    );
  }
  assert.deepEqual(work, [], "no game rendered or exported");
  assert.deepEqual(readdirSync(media), [], "nothing written under the media directory");
  console.log("OK: renderSeries refuses a blocked runner's series before any work");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("series.blocked.contract: all checks passed");
