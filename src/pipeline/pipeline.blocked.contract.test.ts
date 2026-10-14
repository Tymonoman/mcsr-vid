// Contract test for the pipeline's own blocked-player gate (`runPipeline`, src/pipeline/pipeline.ts),
// from the docs alone (CLAUDE.md "Blocked players"; handbook/claude-md-reference.md: "`runPipeline`
// refuses too, right after the match fetch and before VOD discovery or any write, so the callers with
// no gate of their own — `npm run batch`, `npm run generate-project`, the TUI — never download a
// blocked runner's footage"). Promises:
//
//   1. A blocked runner's real match rejects with a "blocked player" error.
//   2. Nothing past the match fetch: no Twitch/VOD discovery request, no download stage.
//   3. No write: the match directory is never created.
//   4. Any case.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/pipeline/pipeline.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { runPipeline } from "./pipeline.js";

const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, fetch: globalThis.fetch };
config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-pipeline-contract-"));

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requests.push(url.href);
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (url.hostname !== "api.mcsrranked.com" || !m) throw new Error(`no network in this test: ${url.href}`);
  return new Response(JSON.stringify({ status: "success", data: fixture(Number(m[1])) }));
}) as typeof fetch;

try {
  config.blockedPlayers = ["AQUACORDE", "beefsalad"]; // any case
  for (const id of [12902901, 13549300]) {
    requests.length = 0;
    const stages: string[] = [];
    await assert.rejects(runPipeline(String(id), { onEvent: (e) => stages.push(e.stage) }), /blocked player/);
    assert.deepEqual(
      requests,
      [`https://api.mcsrranked.com/matches/${id}`],
      `#${id}: nothing past the match fetch`,
    );
    assert.ok(!stages.includes("download"), `#${id}: no download stage`);
    assert.ok(!existsSync(matchDir(id)), `#${id}: no match directory written`);
  }
  console.log(
    "OK: runPipeline stops a blocked runner's match at the fetch — no discovery, no download, no write",
  );
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
}

console.log("pipeline.contract: all checks passed");
