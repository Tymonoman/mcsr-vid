// Contract test: the pipeline never renders a DNF (the operator, 16 Oct 2026: "remember not to post
// DNF matches also dont suggest them"). `runPipeline` is the root every render goes through — the
// dashboard's Render, the nightly, `npm run batch`, the TUI — so it refuses one right after the
// match fetch, the way it refuses a blocked runner. Written from the rule:
//  1. A forfeited ranked match rejects with the DNF line; nothing past the match fetch, no write.
//  2. A forfeited playoff game gets past the gate: playoffs are always posted as is (the operator,
//     the same day: "playoffs dont have rules they are always posted as is").
// The MCSR API is a fake (real fixtures, the saved Season 11 bracket); anything else is refused.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/pipeline/pipeline.dnf.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FeedMatch, MatchInfo, PlayoffBracket } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { runPipeline } from "./pipeline.js";

const saved = { mediaDir: config.mediaDir, fetch: globalThis.fetch };
const media = mkdtempSync(path.join(tmpdir(), "mcsr-pipeline-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const finished = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const bracket: PlayoffBracket = JSON.parse(
  readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"),
).data.data;
const slot9 = bracket.matches.find((m) => m.id === 9)!;
const [edcr, lauveer] = [bracket.players[0]!, bracket.players[15]!];

const FORFEIT = 23_000_001;
const G1 = 23_000_011; // forfeited at 10:14, a winner on record
const G2 = 23_000_012; // finished
const seated = (id: number, date: number, forfeited: boolean): MatchInfo =>
  ({
    ...finished,
    id,
    type: 3,
    season: 12,
    date,
    players: [
      { ...finished.players[0]!, uuid: edcr.uuid, nickname: edcr.nickname },
      { ...finished.players[1]!, uuid: lauveer.uuid, nickname: lauveer.nickname },
    ],
    result: { uuid: edcr.uuid, time: 614_061 },
    forfeited,
    completions: forfeited ? [] : [{ uuid: edcr.uuid, time: 614_061 }],
    changes: [],
    // Both attached, so nothing goes looking for them on Twitch once past the gate.
    vod: [edcr, lauveer].map((p) => ({
      uuid: p.uuid,
      url: `https://www.twitch.tv/videos/${p.nickname}`,
      startsAt: date,
    })),
  }) as MatchInfo;
const served = new Map<number, MatchInfo>([
  [FORFEIT, { ...finished, id: FORFEIT, forfeited: true, completions: [] }],
  [G1, seated(G1, slot9.startTime! + 300, true)],
  [G2, seated(G2, slot9.startTime! + 1500, false)],
]);
const feed = (id: number): FeedMatch => {
  const { timelines: _t, completions: _c, ...rest } = served.get(id)!;
  return rest;
};

const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  requests.push(url.pathname);
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  if (url.hostname === "api.mcsrranked.com") {
    const m = /^\/matches\/(\d+)$/.exec(url.pathname);
    if (m && served.has(Number(m[1]))) return ok(served.get(Number(m[1])));
    if (url.pathname === "/playoffs/11") return ok({ data: bracket });
    if (/^\/users\/[^/]+\/matches$/.test(url.pathname)) return ok([feed(G2), feed(G1)]);
  }
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

try {
  // --- 1. A ranked forfeit --------------------------------------------------------------------------
  const stages: string[] = [];
  await assert.rejects(
    runPipeline(String(FORFEIT), { onEvent: (e) => stages.push(e.stage) }),
    new RegExp(`match ${FORFEIT} is a DNF \\(nobody finished\\) — it is not rendered`),
  );
  assert.deepEqual(requests, [`/matches/${FORFEIT}`], "nothing past the match fetch");
  assert.ok(!stages.includes("download"), "no download stage");
  assert.ok(!existsSync(matchDir(FORFEIT)), "no match directory written");
  console.log("OK: runPipeline stops a DNF at the fetch — no discovery, no download, no write");

  // --- 2. A forfeited playoff game ------------------------------------------------------------------
  // Past the gate it goes on to read the players, which this test refuses: any failure but the DNF
  // line is the gate letting it through.
  const err = await runPipeline(String(G1), {}).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(
    err === null || !/is a DNF/.test(err.message),
    `a forfeited playoff game is rendered: ${err?.message}`,
  );
  console.log("OK: a forfeited playoff game gets past the gate");
} finally {
  config.mediaDir = saved.mediaDir;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("pipeline.dnf.contract: all checks passed");
