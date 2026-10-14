// Self-check for pipeline.ts's blocked-player gate. batch, the TUI and generate-project call
// runPipeline with no gate of their own, so a blocked runner's match must stop at the fetch:
// no VOD discovery, no download, nothing written under the match directory.
// Run: npx tsx src/pipeline/pipeline.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";

config.mediaDir = await mkdtemp(path.join(tmpdir(), "mcsr-pipeline-media-"));

const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (!url.endsWith("/matches/999")) throw new Error(`unexpected fetch ${url}`);
  const players = [
    { uuid: "a", nickname: "BeefSalad" },
    { uuid: "b", nickname: "Feinberg" },
  ];
  const data = {
    id: 999,
    type: 2,
    players,
    vod: players.map((p) => ({ uuid: p.uuid, url: `https://www.twitch.tv/videos/${p.uuid}`, startsAt: 0 })),
    timelines: [],
    result: { uuid: null, time: 0 },
  };
  return new Response(JSON.stringify({ status: "success", data }), { status: 200 });
}) as typeof fetch;

const { runPipeline } = await import("./pipeline.js");

const stages: string[] = [];
await assert.rejects(
  runPipeline("999", { onEvent: (e) => stages.push(e.stage) }),
  /blocked player/,
);
assert.deepEqual(fetched, ["https://api.mcsrranked.com/matches/999"], "nothing past the match fetch");
assert.ok(!stages.includes("download"), "no download stage");
assert.ok(!existsSync(matchDir(999)), "match directory not created");

console.log("pipeline.test: ok");
