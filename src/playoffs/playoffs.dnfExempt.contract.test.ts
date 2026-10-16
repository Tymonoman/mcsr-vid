// Contract test: a forfeited playoff game passes every DNF gate. The operator, 16 Oct 2026, after
// "remember not to post DNF matches also dont suggest them": "playoffs dont have rules they are
// always posted as is". Written from the rule: a playoff game — alone in its slot, or a game of a
// series — is never hidden, skipped, refused or held as a DNF, forfeited or not; a forfeited ranked
// match beside it is, at every one of the same gates (so each gate is live in this harness):
//   the board · matchIsDnf · the nightly · runPipeline · Save (hooks) · the upload, both kinds ·
//   the X post · the morning report's Needs-you.
// (Adopt and auto-hooks go through `matchIsDnf` and Save the same way.) The MCSR API is a fake: real
// fixtures, the saved Season 11 bracket. Nothing renders, nothing is sent.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/playoffs/playoffs.dnfExempt.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FeedMatch, MatchInfo, PlayoffBracket } from "../api/types.js";
import { config, matchDir } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-playoff-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
process.env.MCSR_ARCHIVE_DIR ??= path.join(media, "archive");
const saved = { config: { ...config }, fetch: globalThis.fetch };
config.mediaDir = media;
config.youtubeUploadEnabled = true;
config.playoffsFirst = true;

const finished = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const bracket: PlayoffBracket = JSON.parse(
  readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"),
).data.data;
const slot9 = bracket.matches.find((m) => m.id === 9)!; // edcr vs lauveer
const slot10 = bracket.matches.find((m) => m.id === 10)!;
const seat = (slotId: number, i: number) =>
  bracket.players[bracket.matches.find((m) => m.id === slotId)!.participants[i]!.player]!;

/** A private-room game, forfeited at 10:14 with a winner on record and no completion. */
const game = (id: number, slotId: number, date: number, forfeited: boolean): MatchInfo => {
  const [a, b] = [seat(slotId, 0), seat(slotId, 1)];
  return {
    ...finished,
    id,
    type: 3,
    season: 12,
    date,
    players: [
      { ...finished.players[0]!, uuid: a.uuid, nickname: a.nickname },
      { ...finished.players[1]!, uuid: b.uuid, nickname: b.nickname },
    ],
    result: { uuid: a.uuid, time: 614_061 },
    forfeited,
    completions: forfeited ? [] : [{ uuid: a.uuid, time: 614_061 }],
    changes: [],
    // Both attached, so nothing goes looking for them on Twitch.
    vod: [a, b].map((p) => ({
      uuid: p.uuid,
      url: `https://www.twitch.tv/videos/${p.nickname}`,
      startsAt: date,
    })),
  } as MatchInfo;
};
const LONE = 25_000_001; // the only game of slot 10 so far, a forfeit
const G1 = 25_000_011; // slot 9 game 1, a forfeit
const G2 = 25_000_012; // slot 9 game 2, finished
const RANKED = 25_000_099; // the control: a forfeited ranked match
const served = new Map<number, MatchInfo>([
  [LONE, game(LONE, 10, slot10.startTime! + 300, true)],
  [G1, game(G1, 9, slot9.startTime! + 300, true)],
  [G2, game(G2, 9, slot9.startTime! + 1500, false)],
  [RANKED, { ...finished, id: RANKED, forfeited: true, completions: [] }],
]);
const feed = (id: number): FeedMatch => {
  const { timelines: _t, completions: _c, ...rest } = served.get(id)!;
  return rest;
};
const histories = new Map<string, FeedMatch[]>([
  [seat(9, 0).uuid, [feed(G2), feed(G1)]],
  [seat(9, 1).uuid, [feed(G2), feed(G1)]],
  [seat(10, 0).uuid, [feed(LONE)]],
  [seat(10, 1).uuid, [feed(LONE)]],
]);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  if (url.hostname === "api.mcsrranked.com") {
    const m = /^\/matches\/(\d+)$/.exec(url.pathname);
    if (m && served.has(Number(m[1]))) return ok(served.get(Number(m[1])));
    if (url.pathname === "/playoffs" || url.pathname === "/playoffs/11") return ok({ data: bracket });
    const h = /^\/users\/([^/]+)\/matches$/.exec(url.pathname);
    if (h) return ok(histories.get(h[1]!) ?? []);
  }
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

const { _resetPlayoffsForTest, matchIsDnf, playoffBoard } = await import("./playoffs.js");
const { nightlyEligible, pickNightlyCandidate, resolveQueuedPick } = await import("../dashboard/nightly.js");
const { setNightlyQueue } = await import("../dashboard/matchShelf.js");
const { runPipeline } = await import("../pipeline/pipeline.js");
const { saveHooks } = await import("../dashboard/shortFlow.js");
const { beginUpload } = await import("../youtube/youtubeUpload.js");
const { planXPost } = await import("../x/xPost.js");
const { gatherFacts } = await import("../telegram/facts.js");

const DNF_LINE = /is a DNF \(nobody finished\)/;
/** Runs `fn` with console.error captured. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = error;
  }
}
/** Saved hooks, an export and a cut Short on disk: everything an upload of either kind needs. */
function ready(id: number): void {
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `match-${id}.title.edited.txt`), "WHO BLINKS FIRST? | a vs b | MCSR Ranked\n");
  writeFileSync(path.join(dir, `final-${id}.mp4`), "x");
  const hook = "WHO BLINKS FIRST?";
  writeFileSync(path.join(dir, `short-${id}.hook.txt`), `${hook}\n`);
  writeFileSync(path.join(dir, `short-${id}.mp4`), "x");
  writeFileSync(path.join(dir, `short-${id}.title.txt`), `${hook} | a vs b #mcsr #minecraft\n`);
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
}

try {
  _resetPlayoffsForTest();

  // --- The board: a slot whose only game is a forfeit still shows it; so does a series ------------
  const board = await playoffBoard(slot9.startTime! + 3600);
  const games = (id: number) => board.slots.find((s) => s.id === id)!.games.map((g) => g.matchId);
  assert.deepEqual(games(10), [LONE], "a lone forfeited playoff game is on the board");
  assert.deepEqual(games(9), [G1, G2], "a series' forfeited game 1 is on the board, numbered first");
  console.log("OK: the board keeps a lone forfeited playoff game and a series' forfeit");

  // --- matchIsDnf ------------------------------------------------------------------------------------
  assert.equal(await matchIsDnf(LONE), false, "a lone forfeited playoff game is not a DNF");
  assert.equal(await matchIsDnf(G1), false, "nor a series' forfeited game");
  assert.equal(await matchIsDnf(RANKED), true, "the ranked forfeit is");
  console.log("OK: matchIsDnf never calls a playoff game a DNF");

  // --- The nightly: queued, and as the board's own pick ---------------------------------------------
  {
    const night = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 };
    const vodsReady = async () => true;
    const queue = [RANKED, LONE];
    const { value, lines } = await quiet(() =>
      pickNightlyCandidate([], { ...night, queue }, nightlyEligible(queue, vodsReady), resolveQueuedPick),
    );
    assert.equal(value?.metrics.matchId, LONE, "the queued forfeited playoff game is tonight's render");
    assert.ok(
      lines.some((l) => l.includes(`#${RANKED} skipped`)),
      "past the ranked forfeit, which is skipped",
    );
    const boardPick = {
      metrics: { matchId: G1, players: [seat(9, 0).nickname, seat(9, 1).nickname] as [string, string] },
      bucket: "playoffs",
    };
    assert.equal(
      await nightlyEligible([], vodsReady)(boardPick),
      true,
      "a board pick of a forfeited game is eligible",
    );
    console.log("OK: the nightly renders a forfeited playoff game, queued or from the board");
  }

  // --- runPipeline -------------------------------------------------------------------------------
  {
    const ranked = await runPipeline(String(RANKED), {}).then(
      () => null,
      (e: Error) => e,
    );
    assert.match(ranked?.message ?? "", DNF_LINE, "the ranked forfeit stops at the gate");
    // Past the gate it goes on to read the players, which this test refuses: any failure but the DNF
    // line is the gate letting it through.
    const lone = await runPipeline(String(LONE), {}).then(
      () => null,
      (e: Error) => e,
    );
    assert.doesNotMatch(lone?.message ?? "", DNF_LINE, "the playoff game gets past it");
    console.log("OK: runPipeline lets a forfeited playoff game through");
  }

  // --- Save (hooks) ----------------------------------------------------------------------------------
  {
    ready(LONE);
    ready(RANKED);
    const body = { titleHook: "Who blinks first?", shortHook: "DOWN TO THE LAST HEART" };
    const deps = { pick: async () => {}, render: async () => "stand-in", refreshChannel: async () => {} };
    const ranked = await saveHooks(RANKED, body, deps);
    assert.ok(
      ranked && "error" in ranked && DNF_LINE.test(ranked.error),
      "the ranked forfeit's Save is refused as a DNF",
    );
    const lone = await saveHooks(LONE, body, deps);
    // A game of a series not yet joined has its own refusal (its hooks are the series'); never this one.
    assert.ok(
      !(lone && "error" in lone && DNF_LINE.test(lone.error)),
      `the playoff game is not refused as a DNF: ${JSON.stringify(lone)}`,
    );
    console.log("OK: Save never refuses a forfeited playoff game as a DNF");
  }

  // --- The upload, both kinds --------------------------------------------------------------------------
  {
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
    for (const kind of ["video", "short"] as const) {
      const ranked = await upload(RANKED, kind);
      assert.ok("error" in ranked && DNF_LINE.test(ranked.error), `${kind}: the ranked forfeit is refused`);
      const lone = await upload(LONE, kind);
      assert.ok(!("error" in lone), `${kind}: the playoff game is not refused: ${JSON.stringify(lone)}`);
      await lone.finished;
    }
    assert.deepEqual(sent, [`final-${LONE}.mp4`, `short-${LONE}.mp4`], "only the playoff game reached send");
    console.log("OK: the upload sends a forfeited playoff game, long-form and Short");
  }

  // --- The X post ----------------------------------------------------------------------------------
  {
    for (const id of [LONE, RANKED]) {
      const dir = matchDir(id);
      writeFileSync(
        path.join(dir, "youtube.json"),
        JSON.stringify({
          videoId: `vid${id}`,
          uploadedAt: "2026-10-01T19:00:00Z",
          publishAt: "2026-10-01T19:00:00Z",
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
        }),
      );
      writeFileSync(
        path.join(dir, `short-${id}.hand.json`),
        JSON.stringify({ hook: "WHO BLINKS FIRST?", builtAt: "t", windowMatchSec: [0, 30], pov: "left" }),
      );
    }
    const ranked = await planXPost(RANKED);
    assert.ok(
      typeof ranked === "string" && DNF_LINE.test(ranked),
      `the ranked forfeit is never posted: ${JSON.stringify(ranked)}`,
    );
    const lone = await planXPost(LONE);
    assert.ok(
      !(typeof lone === "string" && DNF_LINE.test(lone)),
      `the playoff game is not refused as a DNF: ${JSON.stringify(lone)}`,
    );
    console.log("OK: the X post never refuses a forfeited playoff game as a DNF");
  }

  // --- Needs-you -------------------------------------------------------------------------------------
  {
    process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-token.json");
    setNightlyQueue([LONE, RANKED]);
    const { value: facts } = await quiet(() =>
      gatherFacts(Date.now(), Date.now() - 86_400_000, ["needsYou"]),
    );
    const items = facts.needsYou.ok ? facts.needsYou.data.items : [];
    const dnfLines = items.filter((i) => /a DNF/.test(i.text)).map((i) => i.matchId);
    assert.deepEqual(dnfLines, [RANKED], "only the ranked forfeit is named as a DNF in tonight's queue");
    console.log("OK: Needs-you never names a queued playoff game as a DNF");
  }
} finally {
  Object.assign(config, saved.config);
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("playoffs.dnfExempt.contract: all checks passed");
