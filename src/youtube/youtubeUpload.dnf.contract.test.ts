// Contract test: a DNF is never uploaded, long-form or Short (the operator, 16 Oct 2026: "remember
// not to post DNF matches also dont suggest them"). A DNF is a match nobody finished — a forfeit, no
// winner on record, or no completion. A playoff series is one video: a forfeited game inside an
// otherwise finished series does not block it; a single forfeited playoff game is a DNF like any
// ranked match. Written from the rule:
//  1. A ranked DNF with its hooks saved and every file in place is refused, both kinds, with one
//     line saying why, and `videos.insert` (the `send` seam of `beginUpload`) is never reached.
//  2. The same files for a finished match reach `send`.
//  3. A series whose game 1 is a forfeit and game 2 finished goes up; a lone forfeited playoff
//     game does not.
// The MCSR API is a fake serving real fixtures and the saved Season 11 bracket; nothing is sent.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/youtube/youtubeUpload.dnf.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FeedMatch, MatchInfo, PlayoffBracket } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { beginUpload } from "./youtubeUpload.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-upload-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = { mediaDir: config.mediaDir, enabled: config.youtubeUploadEnabled, fetch: globalThis.fetch };
config.mediaDir = media;
config.youtubeUploadEnabled = true;

const finished = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const bracket: PlayoffBracket = JSON.parse(
  readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"),
).data.data;
const slot9 = bracket.matches.find((m) => m.id === 9)!; // edcr vs lauveer
const slot10 = bracket.matches.find((m) => m.id === 10)!;
const [edcr, lauveer] = [bracket.players[0]!, bracket.players[15]!];
const seat10 = (i: number) => bracket.players[slot10.participants[i]!.player]!;

/** A private-room game between two seeds, as the API serves it. */
const game = (
  id: number,
  a: { uuid: string; nickname: string },
  b: { uuid: string; nickname: string },
  date: number,
  forfeited: boolean,
): MatchInfo =>
  ({
    ...finished,
    id,
    type: 3,
    season: 12,
    date,
    players: [
      { ...finished.players[0]!, uuid: a.uuid, nickname: a.nickname },
      { ...finished.players[1]!, uuid: b.uuid, nickname: b.nickname },
    ],
    result: { uuid: a.uuid, time: forfeited ? 614_061 : 480_000 },
    forfeited,
    completions: forfeited ? [] : [{ uuid: a.uuid, time: 480_000 }],
    timelines: [],
    changes: [],
    vod: [],
  }) as MatchInfo;

const RANKED_DNF = 22_000_001;
const RANKED_OK = 22_000_002;
const SERIES_G1 = 22_000_011; // forfeited at 10:14
const SERIES_G2 = 22_000_012; // finished
const LONE = 22_000_021; // a lone forfeited playoff game
const served = new Map<number, MatchInfo>([
  [RANKED_DNF, { ...finished, id: RANKED_DNF, forfeited: true, completions: [] }],
  [RANKED_OK, { ...finished, id: RANKED_OK }],
  [SERIES_G1, game(SERIES_G1, edcr, lauveer, slot9.startTime! + 300, true)],
  [SERIES_G2, game(SERIES_G2, lauveer, edcr, slot9.startTime! + 1500, false)],
  [LONE, game(LONE, seat10(0), seat10(1), slot10.startTime! + 300, true)],
]);
const feed = (id: number): FeedMatch => {
  const { timelines: _t, completions: _c, ...rest } = served.get(id)!;
  return rest;
};
const histories: Record<string, FeedMatch[]> = {
  [edcr.uuid]: [feed(SERIES_G2), feed(SERIES_G1)],
  [lauveer.uuid]: [feed(SERIES_G2), feed(SERIES_G1)],
  [seat10(0).uuid]: [feed(LONE)],
  [seat10(1).uuid]: [feed(LONE)],
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m && served.has(Number(m[1]))) return ok(served.get(Number(m[1])));
  if (url.pathname === "/playoffs/11") return ok({ data: bracket });
  const h = /^\/users\/([^/]+)\/matches$/.exec(url.pathname);
  if (h) return ok(histories[h[1]!] ?? []);
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

/** Everything an upload of both kinds needs on disk: saved hooks, the export, the cut Short. */
function ready(id: number, series: number[] = []): string {
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `match-${id}.title.edited.txt`),
    "WHO BLINKS FIRST? | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun\n",
  );
  writeFileSync(path.join(dir, `final-${id}.mp4`), "x");
  const hook = "WHO BLINKS FIRST?";
  writeFileSync(path.join(dir, `short-${id}.hook.txt`), `${hook}\n`);
  writeFileSync(path.join(dir, `short-${id}.mp4`), "x");
  writeFileSync(path.join(dir, `short-${id}.title.txt`), `${hook} | edcr vs doogile #mcsr #minecraft\n`);
  writeFileSync(
    path.join(dir, `short-${id}.cut.json`),
    JSON.stringify({
      gameMatchId: id,
      startMs: 0,
      endMs: 20_000,
      pov: "both",
      hook,
      pickCreatedAt: "t",
      renderedAt: "t",
    }),
  );
  if (series.length)
    writeFileSync(
      path.join(dir, "series.json"),
      JSON.stringify({ games: series.map((g) => ({ matchId: g })) }),
    );
  return dir;
}

const sent: string[] = [];
const send = (async (opts: { filePath: string }) => {
  sent.push(path.basename(opts.filePath));
  throw new Error("stand-in: nothing goes to YouTube from a test");
}) as unknown as Parameters<typeof beginUpload>[2];
const upload = (id: number, kind: "video" | "short") =>
  beginUpload(
    id,
    {
      kind,
      privacyStatus: "private",
      ...(kind === "video" ? { videoPath: path.join(matchDir(id), `final-${id}.mp4`) } : {}),
    },
    send,
  );
/** Refused, and with what; or the upload's own settled error once it started. */
async function outcome(
  id: number,
  kind: "video" | "short",
): Promise<{ refused: string } | { started: true }> {
  const begun = await upload(id, kind);
  if ("error" in begun) return { refused: begun.error };
  await begun.finished;
  return { started: true };
}

try {
  // --- 1. A ranked DNF ----------------------------------------------------------------------------
  ready(RANKED_DNF);
  for (const kind of ["video", "short"] as const) {
    const begun = await upload(RANKED_DNF, kind);
    assert.ok("error" in begun, `${kind}: a DNF is refused`);
    assert.equal(begun.status, 403, `${kind}: refused outright, not held`);
    assert.equal(begun.error, `match ${RANKED_DNF} is a DNF (nobody finished) — uploads of it are refused`);
  }
  assert.deepEqual(sent, [], "videos.insert is never reached for a DNF");
  console.log("OK: a ranked DNF is refused, long-form and Short, before videos.insert");

  // --- 2. A finished match ------------------------------------------------------------------------
  ready(RANKED_OK);
  assert.deepEqual(await outcome(RANKED_OK, "video"), { started: true }, "the long-form gets as far as send");
  assert.deepEqual(await outcome(RANKED_OK, "short"), { started: true }, "and so does the Short");
  assert.deepEqual(sent, [`final-${RANKED_OK}.mp4`, `short-${RANKED_OK}.mp4`]);
  console.log("OK: a finished match with the same files reaches videos.insert");

  // --- 3. A series --------------------------------------------------------------------------------
  sent.length = 0;
  ready(SERIES_G1, [SERIES_G1, SERIES_G2]);
  assert.deepEqual(
    await outcome(SERIES_G1, "video"),
    { started: true },
    "a series with a forfeited game 1 goes up",
  );
  assert.deepEqual(await outcome(SERIES_G1, "short"), { started: true }, "its Short too");
  ready(LONE);
  for (const kind of ["video", "short"] as const) {
    const lone = await outcome(LONE, kind);
    assert.ok(
      "refused" in lone && /is a DNF/.test(lone.refused),
      `${kind}: a lone forfeited playoff game is a DNF`,
    );
  }
  assert.deepEqual(
    sent,
    [`final-${SERIES_G1}.mp4`, `short-${SERIES_G1}.mp4`],
    "only the series reached send",
  );
  console.log("OK: a series with one forfeited game is not blocked; a lone forfeited playoff game is");
} finally {
  config.mediaDir = saved.mediaDir;
  config.youtubeUploadEnabled = saved.enabled;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("youtubeUpload.dnf.contract: all checks passed");
