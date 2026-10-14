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
const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  // A playoff game (S11's bracket, played in S12) whose bracket read fails once.
  if (url.endsWith("/matches/998")) {
    const players = [
      { uuid: "c", nickname: "Feinberg" },
      { uuid: "d", nickname: "BlazeMind" },
    ];
    return ok({
      id: 998,
      type: 3,
      season: 12,
      players,
      vod: players.map((p) => ({ uuid: p.uuid, url: `https://www.twitch.tv/videos/${p.uuid}`, startsAt: 0 })),
      timelines: [],
      result: { uuid: "d", time: 600_000 },
      changes: [],
    });
  }
  if (url.endsWith("/playoffs/11")) return new Response("upstream", { status: 503, statusText: "Service Unavailable" });
  if (url.includes("/versus/")) return ok({ results: { ranked: {}, casual: {} } });
  if (/\/users\/[cd]$/.test(url)) return ok({ uuid: url.slice(-1), nickname: url.slice(-1) });
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

// One failed bracket read must fail the fetch stage for a retry, not package the playoff game as an
// ordinary ranked match: the overlay stills that run would write are reused by every later run.
{
  const events: { stage: string; status: string }[] = [];
  const onEvent = (e: { stage: string; status: string }) => {
    events.push(e);
    // Stop a regression here, before the download stage reaches for yt-dlp.
    if (e.stage === "fetch" && e.status === "done") throw new Error("the fetch stage passed");
  };
  await assert.rejects(runPipeline("998", { onEvent }), /\/playoffs\/11 -> 503/);
  assert.ok(!existsSync(matchDir(998)), "nothing written for the match");
  // The head-to-head is the match's own season's, not whatever season is current at render time.
  assert.ok(fetched.some((u) => u.endsWith("/users/c/versus/d?season=12")), "versus read for season 12");
}

console.log("pipeline.test: ok");
