// Self-check for nightly.ts. The scheduler runs unattended at 03:00 UTC, so the two decisions
// nobody will be awake to correct — *when* it fires and *what* it picks — are pinned here.
// The timer itself is not tested: that would be a test of setTimeout.
// Run: npx tsx src/nightly.test.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  chainExport,
  EVENING_COVERAGE_MAX_PER_NIGHT,
  eveningCoverageGap,
  excludeRenderedPairs,
  type ExportStarter,
  isKnownPick,
  isMixedKnownPick,
  isSubEightFinish,
  msUntilNextRun,
  nightlyChainRunning,
  nightlyEligible,
  nightlySideCalls,
  openRankedSlots,
  PAIR_POSTS_WAIT_MS,
  PAIR_SLOTS_PER_48H,
  pairsAtCap,
  pickClause,
  pickContext,
  pickNightlyCandidate,
  playoffPicks,
  previewPick,
  playoffsWithoutVods,
  playoffVodsReady,
  nightlyStarting,
  readNightlyState,
  refreshPairPostsWithin,
  resolveQueuedPick,
  runNightlyOnce,
  shouldChainNextRender,
  SUB_EIGHT_JUMP_MS,
  withinChainWindow,
  withSubEightJump,
  writeNightlyState,
} from "./nightly.js";
import { CACHE_VERSION, dismissSuggestion, type Suggestion } from "./suggest.js";
import { knownUnknownRenderedRecently, recordKnownUnknownRender } from "./matchShelf.js";
import type { PlayoffBoard } from "../playoffs/playoffs.js";
import { startRerender } from "../thumbnails/rerender.js";
import { abortJob, getJob, startJob } from "./jobs.js";
import type { MatchInfo } from "../api/types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

// Before the hour: later today.
assert.equal(msUntilNextRun(at("2026-09-07T01:30:00Z"), 3), 1.5 * HOUR);
// After the hour: tomorrow, which also means crossing a date boundary correctly.
assert.equal(msUntilNextRun(at("2026-09-07T04:00:00Z"), 3), 23 * HOUR);
assert.equal(msUntilNextRun(at("2026-09-07T23:30:00Z"), 3), 3.5 * HOUR);
// Exactly on the hour is the reschedule case at the end of a run. A zero here would spin the
// scheduler: fire, reschedule for now, fire again, forever.
assert.equal(msUntilNextRun(at("2026-09-07T03:00:00Z"), 3), DAY);
// Hour 0 has no special case; it is just "the next midnight".
assert.equal(msUntilNextRun(at("2026-09-07T00:00:00Z"), 0), DAY);
assert.equal(msUntilNextRun(at("2026-09-06T23:59:59Z"), 0), 1000);

// DST is why this is UTC. Europe/Warsaw goes 02:00 -> 03:00 local on 2026-03-29, so a
// local-hour schedule would skip or repeat a day; in UTC every gap is exactly 24h.
for (const day of ["2026-03-28", "2026-03-29", "2026-10-25"]) {
  assert.equal(msUntilNextRun(at(`${day}T03:00:00Z`), 3), DAY, `${day} must be a plain 24h`);
}

// --- Room for a second render. The guards that stop one are re-run by runNightlyOnce itself,
// so this is only the count and the clock.
{
  const night = at("2026-09-07T03:00:00Z");
  // Default config: one render, and nothing chains. This is the assertion that keeps tonight's
  // behaviour unchanged when the feature is left alone.
  assert.equal(shouldChainNextRender(1, 1, night, 3), false, "the default limit stops at one");
  assert.equal(shouldChainNextRender(1, 2, night, 3), true);
  assert.equal(shouldChainNextRender(2, 2, night, 3), false, "the limit is a limit");
  // Inside the window and outside it. Four hours after the hour is already the morning.
  assert.equal(shouldChainNextRender(1, 3, night + 3.9 * HOUR, 3), true);
  assert.equal(shouldChainNextRender(1, 3, night + 4 * HOUR, 3), false, "the window has closed");
  assert.equal(shouldChainNextRender(1, 3, night + 20 * HOUR, 3), false, "and tomorrow is not tonight");
  // A run that started before the hour (the dashboard's "Run now" at midday) is not a night.
  assert.equal(shouldChainNextRender(1, 3, night - HOUR, 3), false, "an hour early is 23 hours late");
  // No schedule means every run is a click, and a click asks for one render.
  assert.equal(shouldChainNextRender(1, 9, night, null), false, "a disabled nightly chains nothing");
}

const suggestion = (matchId: number) => ({ metrics: { matchId } });
const ranked = [suggestion(1), suggestion(2), suggestion(3), suggestion(4)];
const roomy = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 };

type Ctx = Parameters<typeof pickNightlyCandidate>[1];
const picked = async (
  list: readonly { metrics: { matchId: number } }[],
  ctx: Ctx,
  eligible?: (c: { metrics: { matchId: number } }) => Promise<boolean>,
): Promise<number | null> => (await pickNightlyCandidate(list, ctx, eligible))?.metrics.matchId ?? null;

// Ranked order is the whole point of the suggester, so the pick is the first survivor, never
// a "best remaining" recomputed here.
assert.equal(await picked(ranked, roomy), 1);
assert.equal(await picked(ranked, { ...roomy, processedIds: [1, 2] }), 3);
assert.equal(await picked(ranked, { ...roomy, hiddenIds: new Set([1, 3]) }), 2);
// Both filters at once: 1 rendered before, 2 hidden, 3 rendered before.
assert.equal(await picked(ranked, { processedIds: [1, 3], hiddenIds: new Set([2]), freeMatches: 9 }), 4);
assert.equal(await picked(ranked, { ...roomy, processedIds: [1, 2, 3, 4] }), null);
assert.equal(await picked([], roomy), null);
// The operator's queue outranks the ranking, in its own order; a queued id that is processed,
// hidden or no longer on the list drops through to the next entry, then to the ranking.
assert.equal(await picked(ranked, { ...roomy, queue: [3, 2] }), 3);
assert.equal(await picked(ranked, { ...roomy, queue: [3, 2], processedIds: [3] }), 2);
assert.equal(await picked(ranked, { ...roomy, queue: [99, 4] }), 4);
assert.equal(await picked(ranked, { ...roomy, queue: [99] }), 1);

// The pick skips a nightlySkip id and takes the next one; an explicit queue wins.
assert.equal(await picked(ranked, { ...roomy, skipIds: new Set([1]) }), 2);
assert.equal(await picked(ranked, { ...roomy, skipIds: new Set([1, 2]) }), 3);
assert.equal(await picked(ranked, { ...roomy, skipIds: new Set([1]), queue: [1] }), 1);

// An ineligible candidate falls through to the next, and is not the end of the night. Without
// this a playoff game whose players never streamed fails the pipeline before a match directory
// exists, nothing remembers it, and every night of the tournament picks it again.
const probed: number[] = [];
assert.equal(
  await picked(ranked, roomy, async (c) => {
    probed.push(c.metrics.matchId);
    return c.metrics.matchId === 3;
  }),
  3,
);
assert.deepEqual(probed, [1, 2, 3], "in order, and no further than the first that passes");
assert.equal(await picked(ranked, roomy, async () => false), null, "none eligible is a skip, not a hang");

// A match is 2–2.5 GB. Starting one with a single slot left means a render that dies at the write
// stage, having burned the night; unknown capacity is reported as 0 and must behave the same.
assert.equal(await picked(ranked, { ...roomy, freeMatches: 1 }), null);
assert.equal(await picked(ranked, { ...roomy, freeMatches: 0 }), null);
assert.equal(await picked(ranked, { ...roomy, freeMatches: 2 }), 1);

// --- A queued id whose directory holds no project yet is not "processed": creator watch keeps the
// probe's vods.json for the render, and a download-vods prefetch leaves the clips. Counted as
// processed, the queue entry dropped through every night until the VODs expired.
{
  const saved = config.mediaDir;
  config.mediaDir = await mkdtemp(path.join(tmpdir(), "mcsr-nightly-ctx-"));
  assert.ok(config.mediaDir.startsWith(tmpdir()), "refusing to run outside tmpdir");
  try {
    const { setNightlyQueue } = await import("./matchShelf.js");
    const dir = (id: number) => path.join(config.mediaDir, String(id));
    for (const id of [900, 901, 902]) mkdirSync(dir(id));
    writeFileSync(path.join(dir(900), "vods.json"), "[]");
    writeFileSync(path.join(dir(901), "match-901.kdenlive"), "<mlt/>");
    writeFileSync(path.join(dir(902), "vods.json"), "[]");
    setNightlyQueue([900, 901]);
    const ctx = await pickContext();
    assert.deepEqual(ctx.processedIds, [901, 902], "only the queued id with no project is let through");
    assert.equal(
      await picked([suggestion(902), suggestion(901), suggestion(900)], { ...ctx, freeMatches: 9 }),
      900,
    );
    console.log("OK: a queued match with only a vods.json or a prefetch on disk is still picked");
  } finally {
    await rm(config.mediaDir, { recursive: true, force: true });
    config.mediaDir = saved;
  }
}

// --- The bracket's games, in front and in series order, only when the operator has asked. The
// default is off: a config default that changes what tonight's nightly renders is not ours to set.
{
  const seed = (nickname: string) => ({ uuid: nickname, nickname, label: "LCQ", seasonEloRate: 2000 });
  const board: PlayoffBoard = {
    season: 11,
    bracketUrl: "",
    slots: [
      {
        id: 9,
        round: "Round of 16",
        bestOf: 5,
        firstTo: 3,
        startTime: 0,
        seeds: [seed("edcr"), seed("lauveer")],
        games: [
          { matchId: 3, url: "", dateSec: 300, gameNo: 3, winnerUuid: null },
          { matchId: 1, url: "", dateSec: 100, gameNo: 1, winnerUuid: null },
          { matchId: 2, url: "", dateSec: 200, gameNo: 2, winnerUuid: null },
        ],
      },
    ],
  };
  let loads = 0;
  const load = async () => (loads++, board);

  assert.equal(config.playoffsFirst, true, "on by default since 18 Oct 2026 — 'pull them first'");

  config.playoffsFirst = false;
  assert.deepEqual(await playoffPicks(load), [], "off means off");
  assert.equal(loads, 0, "and costs no bracket read");

  config.playoffsFirst = true;
  const picks = await playoffPicks(load);
  assert.deepEqual(
    picks.map((p) => p.metrics.matchId),
    [1, 2, 3],
    "oldest first — series order, which is also the playlist's",
  );
  assert.equal(picks[0]?.bucket, "playoffs");
  assert.deepEqual(picks[0]?.metrics.players, ["edcr", "lauveer"]);
  assert.deepEqual(
    await playoffPicks(async () => {
      throw new Error("429");
    }),
    [],
    "a dead bracket is not the reason a night renders nothing",
  );
}

// --- A blocked seed's games are skipped, same as any other candidate (config.blockedPlayers). ---
{
  const seed = (nickname: string) => ({ uuid: nickname, nickname, label: "LCQ", seasonEloRate: 2000 });
  const board: PlayoffBoard = {
    season: 11,
    bracketUrl: "",
    slots: [
      {
        id: 9,
        round: "Round of 16",
        bestOf: 5,
        firstTo: 3,
        startTime: 0,
        seeds: [seed("edcr"), seed("Aquacorde")],
        games: [{ matchId: 1, url: "", dateSec: 100, gameNo: 1, winnerUuid: null }],
      },
      {
        id: 10,
        round: "Round of 16",
        bestOf: 5,
        firstTo: 3,
        startTime: 0,
        seeds: [seed("doogile"), seed("lauveer")],
        games: [{ matchId: 2, url: "", dateSec: 200, gameNo: 1, winnerUuid: null }],
      },
    ],
  };
  const saved = config.blockedPlayers;
  config.blockedPlayers = ["aquacorde"]; // any case
  config.playoffsFirst = true;
  assert.deepEqual(
    (await playoffPicks(async () => board)).map((p) => p.metrics.matchId),
    [2],
    "edcr vs Aquacorde's game is skipped; doogile vs lauveer's is not",
  );
  config.blockedPlayers = saved;
  config.playoffsFirst = false;
  console.log("OK: playoffPicks skips a blocked seed's games");
}

// --- And whether it ends with a finished MP4. Same gate, same clause shape; the starter is
// injected because the real one is a ten-minute ffmpeg encode.
{
  const started: number[] = [];
  const starter =
    (error: string | null): ExportStarter =>
    async (matchId) => {
      started.push(matchId);
      return error;
    };
  assert.equal(await chainExport(1, "done", true, starter(null)), " + exported");
  assert.equal(await chainExport(2, "done", false, starter(null)), "");
  assert.equal(await chainExport(3, "aborted", true, starter(null)), "");
  assert.equal(await chainExport(4, "failed: ffmpeg died", true, starter(null)), "");
  assert.deepEqual(started, [1], "only a clean render with the flag on may start an encode");
  // An encode that dies is a clause on a rendered match, not a failed night: the project and
  // the overlays are still there to export by hand.
  assert.match(
    await chainExport(5, "done", true, starter("killed by the OOM killer")),
    /export failed: killed/,
  );
}

// --- The record of the last run, and the two guards that end one before it starts. ------------
// A tmp mediaDir as matchShelf.test.ts uses: the state file lives beside the media, so pointing
// config at a scratch directory is the whole of the setup.
const media = await mkdtemp(path.join(tmpdir(), "mcsr-nightly-media-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

try {
  // Nothing written yet reads as "no record", not as a crash — the panel opens on a fresh box.
  assert.equal(readNightlyState(), null, "an absent state file is null");

  const run = {
    startedAt: "2026-09-07T03:00:00.000Z",
    matchId: 13172029,
    players: ["Infume", "NoHacsJustRoblox"],
    outcome: "done" as const,
    short: "done" as const,
  };
  writeNightlyState(run);
  assert.deepEqual(readNightlyState(), run, "what was written is what comes back");

  // Same defensive read as matchShelf.ts: a truncated write must not take the dashboard down.
  writeFileSync(path.join(media, ".nightly.json"), "{ this is not");
  assert.equal(readNightlyState(), null, "a corrupt state file is null, not a throw");
  // And so is a well-formed file with no run in it.
  writeFileSync(path.join(media, ".nightly.json"), '{"lastRun":null}');
  assert.equal(readNightlyState(), null);

  // A run already going is a conflict, not an answer: the route turns `busy` into a 409, which
  // is the same refusal DELETE /api/match gives for the same reason.
  // It leaves the record alone: the render it yielded to is the night's output, and the strip
  // would otherwise show "skipped" over last night's real result after one impatient click.
  writeNightlyState(run);
  const inFlight = await runNightlyOnce("", { renderInFlight: () => true });
  assert.deepEqual(inFlight, { skipped: "a render is already in flight", busy: true });
  assert.deepEqual(readNightlyState(), run, "a conflict is not recorded over the last real run");

  // Nothing eligible is an ordinary answer with a reason, not a failure. The list is injected
  // because the real one is a scan; the job lookup because this box has no jobs.
  const empty = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [] });
  assert.deepEqual(empty, {
    skipped: "every candidate is processed, hidden, without VODs or has no known player, or the disk is full",
  });
  assert.equal(readNightlyState()?.outcome, "skipped", "an ordinary skip is recorded, with its reason");
  assert.equal(
    readNightlyState()?.reason,
    "every candidate is processed, hidden, without VODs or has no known player, or the disk is full",
  );
  assert.equal(readNightlyState()?.matchId, null, "a skip chose nothing, so it names nothing");
  // No list at all is a different sentence — a cold process with a dead API, not a full disk.
  const none = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => null });
  assert.deepEqual(none, { skipped: "no suggestions available" });

  // ...but a chained run's skip is not the night's outcome. The second render of the night is
  // the *usual* skip — the first render's own 2 GB is what takes the disk under the guard — and
  // it must leave the record (and the push) the finished render wrote.
  writeNightlyState(run);
  const chained = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [] }, 2);
  assert.ok(chained.skipped, "the chained run still skips");
  assert.deepEqual(readNightlyState(), run, "and the strip still shows the render that happened");

  // A test server's nightly timer renders and nothing else: chain resume and the YouTube retries
  // are the main server's (`PORT` 8080), or a second process resumes its upload in flight on top.
  {
    const called: string[] = [];
    const spy = (name: string) => async () => void called.push(name);
    const calls = {
      retryFailedPlaylists: spy("playlists"),
      retryPendingComments: spy("comments"),
      retryPendingStudio: spy("studio"),
      shortTick: spy("shorts"),
    };
    nightlySideCalls(false, calls);
    assert.deepEqual(called, [], "a test server's timer resumes no chain and writes nothing to YouTube");
    nightlySideCalls(true, calls);
    assert.deepEqual(
      called,
      ["playlists", "comments", "studio", "shorts"],
      "the main server's does all four",
    );
    console.log("OK: the nightly timer's chain resume and YouTube retries run on the main server only");
  }

  // "Run now" must not move tonight's render. runNightlyOnce touches no timer, and this is the
  // assertion that keeps it that way if someone later reaches for `scheduleNightly` inside it.
  const now = at("2026-09-07T01:30:00Z");
  const before = msUntilNextRun(now, 3);
  await runNightlyOnce("", { renderInFlight: () => true });
  assert.equal(msUntilNextRun(now, 3), before, "a manual run leaves the schedule alone");

  // --- The VOD probe. A playoff game is a private room, so the API attaches nothing and both
  // VODs are found on Twitch; a game whose players never streamed must be skipped rather than
  // fail the pipeline before the match directory that would remember it exists. The probe is
  // injected because the real one shells out to yt-dlp.
  {
    const probed: number[] = [];
    const probe = async (id: number): Promise<MatchInfo> => {
      probed.push(id);
      if (id === 7) throw new Error("yt-dlp exploded");
      return {
        players: [{ uuid: "a" }, { uuid: "b" }],
        vod: id === 1 ? [{ uuid: "a" }, { uuid: "b" }] : [{ uuid: "a" }],
      } as unknown as MatchInfo;
    };
    const pick = (matchId: number, bucket = "playoffs") => ({
      metrics: { matchId, players: ["a", "b"] as [string, string] },
      bucket,
    });

    assert.equal(await playoffVodsReady(pick(9, "upset"), probe), true, "an ordinary suggestion");
    assert.deepEqual(probed, [], "and it costs no listing — the API already attached its VODs");
    assert.equal(await playoffVodsReady(pick(1), probe), true, "both players streamed");
    assert.equal(await playoffVodsReady(pick(2), probe), false, "one of two is not enough");
    assert.equal(await playoffVodsReady(pick(7), probe), false, "a dead listing is not a render");
    assert.deepEqual(probed, [1, 2, 7]);

    assert.equal(await playoffVodsReady(pick(2), probe), false);
    assert.equal(await playoffVodsReady(pick(7), probe), false);
    assert.deepEqual(probed, [1, 2, 7, 7], "a settled no-VOD is remembered; a failure is retried");
    assert.deepEqual(playoffsWithoutVods(), [2]);

    // And the night that renders nothing says so where the operator will see it, not only in
    // the log: an unstreamed bracket would otherwise be a fortnight of "nothing to render".
    const named = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [] });
    assert.deepEqual(named, {
      skipped:
        "every candidate is processed, hidden, without VODs or has no known player, or the disk is full (no VOD: #2)",
    });
  }

  // --- The night's new ending (23 Sept 2026): after the export, the pick — never a Short, never
  // an upload — and the push says how many matches wait for a hook.
  {
    const id = 13559245;
    const dir = path.join(media, String(id));
    mkdirSync(dir, { recursive: true });
    // Nothing picked (a series game whose series is not joined): no clause at all.
    assert.equal(await pickClause(id, async () => {}), "");
    const pick = (source: string) =>
      writeFileSync(
        path.join(dir, `short-${id}.pick.json`),
        JSON.stringify({ gameMatchId: id, startMs: 0, endMs: 20000, pov: "both", source, createdAt: "t" }),
      );
    pick("agy");
    let waited = false;
    assert.equal(
      await pickClause(id, async () => {
        waited = true;
      }),
      " + picked by the model",
    );
    assert.ok(waited, "the clause waits for the pick queue first");
    pick("heuristic");
    assert.equal(await pickClause(id, async () => {}), " + heuristic pick (the model failed)");
    // With the reason on disk, the push carries it: the one line the morning acts on.
    writeFileSync(
      path.join(dir, `short-${id}.pick-error.json`),
      JSON.stringify({ at: "t", message: "Antigravity is not signed in — run: agy" }),
    );
    assert.equal(
      await pickClause(id, async () => {}),
      " + heuristic pick (the model failed: Antigravity is not signed in — run: agy)",
    );
    rmSync(path.join(dir, `short-${id}.pick-error.json`));

    // The push: a skipped night still reminds, one line under the reason. Exported, picked, no
    // hook saved: that is one match waiting.
    writeFileSync(path.join(dir, `final-${id}.mp4`), "x");
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        bodies.push(body);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await runNightlyOnce(url, { renderInFlight: () => false, ranked: async () => [] });
    server.close();
    assert.equal(bodies.length, 1, "one push");
    assert.match(bodies[0]!, /^Nightly skipped — .*\n1 waiting for a hook$/s, bodies[0]);
    console.log("OK: the night ends on the pick, and the push counts the hooks waiting");
  }

  // --- skipNightOf skips exactly that night's scheduled run once and clears; Run now ignores it ---
  {
    const { setSkipNightOf, skipNightOf } = await import("./matchShelf.js");
    const testDate = "2026-09-08";
    const testTime = at("2026-09-08T03:00:00Z");

    // 1. Run now ignores skipNightOf and does not clear it
    setSkipNightOf(testDate);
    assert.equal(skipNightOf(), testDate);
    const runNowResult = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [],
      now: () => testTime,
      scheduled: false,
    });
    assert.notEqual(runNowResult.skipped, "skipped by the operator", "Run now ignores skipNightOf");
    assert.equal(skipNightOf(), testDate, "Run now must not clear skipNightOf");

    // 2. The scheduled run whose date matches skips, notifies one line, and clears the key
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        bodies.push(body);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const scheduledResult = await runNightlyOnce(url, {
      renderInFlight: () => false,
      ranked: async () => [],
      now: () => testTime,
      scheduled: true,
    });
    server.close();

    assert.equal(scheduledResult.skipped, "skipped by the operator", "scheduled run skips");
    assert.equal(readNightlyState()?.outcome, "skipped");
    assert.equal(readNightlyState()?.reason, "skipped by the operator");
    assert.equal(bodies.length, 1, "notified one line");
    assert.equal(bodies[0], "skipped by the operator");
    assert.equal(skipNightOf(), null, "skipNightOf must be cleared after matching run");

    // 3. The next scheduled run is not skipped (it only skips once)
    const nextScheduled = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [],
      now: () => testTime,
      scheduled: true,
    });
    assert.notEqual(
      nextScheduled.skipped,
      "skipped by the operator",
      "skips exactly once — subsequent run is not skipped for operator",
    );

    // 4. A scheduled run on a different date does not skip
    setSkipNightOf("2026-09-09");
    const diffDateResult = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [],
      now: () => testTime, // 2026-09-08 != 2026-09-09
      scheduled: true,
    });
    assert.notEqual(diffDateResult.skipped, "skipped by the operator");
    assert.equal(skipNightOf(), "2026-09-09", "non-matching date is not cleared");
    setSkipNightOf(null);
    console.log("OK: skipNightOf skips scheduled run once and clears; Run now ignores it");
  }

  // --- The known-player gate (1 Oct 2026, the operator: "the suggestion system is shit it
  // recommends and schedules matches that no one will watch") -------------------------------------
  {
    const unknownPick = {
      metrics: { matchId: 9001, players: ["RandoOne", "RandoTwo"] as [string, string] },
      bucket: "chaos",
    };

    // A pool of one, and nobody in it is known: the night skips, names the reason, and renders
    // nothing — readNightlyState().matchId stays null, so the Telegram report's "N waiting for a
    // hook" and the strip's last-run line cannot say a match was rendered that was not.
    const result = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [unknownPick],
    });
    assert.deepEqual(result, {
      // "(no VOD: #2)" rides along: the VOD-probe block above this one permanently remembers #2 as
      // unstreamed (`noVods` is a module-level set, by design — see playoffVodsReady's doc comment),
      // and that note is appended to every skip for the rest of this process.
      skipped:
        "every candidate is processed, hidden, without VODs or has no known player, or the disk is full (no VOD: #2)",
    });
    assert.equal(readNightlyState()?.matchId, null, "an unknown pair is not rendered");
    assert.match(readNightlyState()?.reason ?? "", /no known player/);

    // The same pick, not run through startJob (that would be a real pipeline invocation): the
    // operator's own queue always wins over the gate, exactly as it already wins over nightlySkip.
    assert.equal(await nightlyEligible([])(unknownPick), false, "unqueued and unknown: not eligible");
    assert.equal(await nightlyEligible([9001])(unknownPick), true, "queued: the gate does not apply");
    assert.deepEqual(
      await pickNightlyCandidate([unknownPick], { ...roomy, queue: [9001] }, nightlyEligible([9001])),
      unknownPick,
      "queued and unknown — it IS picked",
    );

    // A blocked match is never rendered, even queued: the block outranks the queue, the way
    // nothing else here does (config.blockedPlayers, 2 Oct 2026).
    const blockedPick = {
      metrics: { matchId: 9050, players: ["Aquacorde", "doogile"] as [string, string] },
      bucket: "chaos",
    };
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["aquacorde"]; // any case
    assert.equal(
      await nightlyEligible([9050])(blockedPick),
      false,
      "queued and known would both say yes — the block says no first",
    );
    assert.equal(
      await pickNightlyCandidate([blockedPick], { ...roomy, queue: [9050] }, nightlyEligible([9050])),
      null,
      "so the queue finds nothing to pick",
    );
    // Renamed since: the API's names pass, but a prefetch (`npm run download-vods`) left the clip
    // and chat under the old name — and a queued id with no project is pickable again.
    const renamedDir = path.join(config.mediaDir, "9051");
    mkdirSync(renamedDir, { recursive: true });
    writeFileSync(path.join(renamedDir, "Aquacorde.mp4"), "");
    writeFileSync(path.join(renamedDir, "chat-Aquacorde.json"), "[]");
    const renamedPick = {
      metrics: { matchId: 9051, players: ["NewName", "doogile"] as [string, string] },
      bucket: "chaos",
    };
    assert.equal(await nightlyEligible([9051])(renamedPick), false, "the clip on disk is blocked too");
    assert.equal(
      await pickNightlyCandidate([renamedPick], { ...roomy, queue: [9051] }, nightlyEligible([9051])),
      null,
      "so a renamed blocked runner's queued match is not picked",
    );
    rmSync(renamedDir, { recursive: true, force: true });
    console.log("OK: the nightly refuses a queued match whose clips on disk name a blocked runner");
    config.blockedPlayers = savedBlocked;

    // A playoff pick is always known: the bracket's players are the season's top 16, and their
    // Twitch following is often unmeasured (`isKnownPick` reads the scan's cache, no API call).
    const playoffPick = {
      metrics: { matchId: 9002, players: ["RandoThree", "RandoFour"] as [string, string] },
      bucket: "playoffs",
    };
    assert.equal(isKnownPick(playoffPick), true, "a playoff pick is known regardless of followers");
    assert.equal(isKnownPick(unknownPick), false, "an ordinary no-name pick is not");

    // Zero suggestions at all (not just zero known ones) is the same skip path, not a throw —
    // already pinned above (`empty`/`none`), and `isKnownPick` never runs when there is nothing to
    // call it on.
    assert.equal(
      await pickNightlyCandidate([], { ...roomy, queue: [] }, nightlyEligible([])),
      null,
      "nothing to pick from is a null, not a throw",
    );

    // A queued id the latest scan trimmed off the ranked list: the scan's own pool first, no API
    // call — resolveQueuedPick is the live default pickNightlyCandidate falls back to.
    writeFileSync(
      path.join(media, ".suggest-cache.json"),
      JSON.stringify({
        version: CACHE_VERSION,
        pool: {
          "9003": { metrics: { matchId: 9003, players: ["PoolOne", "PoolTwo"] } },
          "9004": { metrics: { matchId: 9004, players: ["PoolOne", "Aquacorde"] } },
        },
      }),
    );
    assert.deepEqual(
      await resolveQueuedPick(9003),
      { metrics: { matchId: 9003, players: ["PoolOne", "PoolTwo"] }, bucket: "queued" },
      "resolved from the pool, not fetched",
    );
    // Resolved from the pool, and refused all the same: the operator's own queue must not go
    // silently empty for it (resolveQueuedPick's whole point), but it must not resolve to a
    // blocked match either.
    const savedBlocked2 = config.blockedPlayers;
    config.blockedPlayers = ["Aquacorde"];
    assert.equal(await resolveQueuedPick(9004), null, "a blocked pooled pick resolves to nothing");
    config.blockedPlayers = savedBlocked2;
    // The preview (`previewPick`, behind the polled GET /api/nightly) takes a queued id off the list
    // from the pool only: 9003 shows, 9998 is left out, and nothing reaches the network — only a run
    // may spend a getMatch on it.
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      throw new Error("the preview must not fetch");
    }) as typeof fetch;
    try {
      const ranked = [
        { metrics: { matchId: 9010, players: ["Feinberg", "zzz"] as [string, string] }, bucket: "chaos" },
      ];
      assert.equal((await previewPick(ranked, { ...roomy, queue: [9998, 9003] }))?.metrics.matchId, 9003);
      assert.equal(
        (await previewPick(ranked, { ...roomy, queue: [9998] }))?.metrics.matchId,
        9010,
        "9998 left out",
      );
      assert.deepEqual(fetched, [], "the preview never calls the network");
      // Queued, then dismissed: the card stays in the pool (and the queue), but the operator
      // rejected it — neither the run nor the preview resolves it, and no getMatch stands in.
      dismissSuggestion(9003);
      assert.equal(await resolveQueuedPick(9003), null, "a dismissed queued card resolves to nothing");
      assert.equal(
        (await previewPick(ranked, { ...roomy, queue: [9003] }))?.metrics.matchId,
        9010,
        "the preview skips it too",
      );
      assert.deepEqual(fetched, [], "and nothing is fetched for it");
      console.log("OK: a card queued and then dismissed is not rendered that night");
    } finally {
      globalThis.fetch = realFetch;
    }
    // Missing from the pool too: resolveQueuedPick would fall to one getMatch call (not exercised
    // here — a live API call does not belong in a unit test); pickNightlyCandidate's own default
    // resolver (no injection) still drops a queued id it cannot resolve, exactly as before this
    // existed.
    assert.equal(
      await pickNightlyCandidate([], { ...roomy, queue: [9999] }),
      null,
      "an unresolvable queued id drops through rather than hanging the pick",
    );

    console.log(
      "OK: the known-player gate skips a no-name match; the queue and the bracket both override it",
    );
  }

  // A render clicked elsewhere has no directory until fetch-match and VOD discovery finish; the
  // default busy check (nothing injected) still sees it, and the night does not start a second
  // pipeline on top of it. The API stalls, so the clicked one sits in its fetch with nothing written.
  {
    const realFetch = globalThis.fetch;
    let unstall: () => void = () => {};
    globalThis.fetch = (() =>
      new Promise<Response>((_, reject) => (unstall = () => reject(new Error("stalled"))))) as typeof fetch;
    try {
      const clicked = 13_300_001;
      startJob(clicked);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(existsSync(path.join(media, String(clicked))), false, "no directory yet");
      const out = await runNightlyOnce("", {
        scheduled: true,
        thumbnailWaitMs: 0,
        ranked: async () => [
          { metrics: { matchId: 13_300_002, players: ["doogile", "edcr"] }, bucket: "known" },
        ],
      });
      assert.deepEqual(out, { skipped: "a render is already in flight", busy: true });
      assert.equal(getJob(13_300_002), undefined, "the night's pick was not started");
      abortJob(clicked);
      unstall();
      while (!getJob(clicked)?.done) await new Promise((r) => setTimeout(r, 10));
    } finally {
      globalThis.fetch = realFetch;
    }
    console.log("OK: a render with no directory yet still counts as busy");
  }

  // A thumbnail re-render in flight: the scheduled run waits it out instead of skipping the
  // night, and says so (`nightlyStarting`) so the bulk re-render holds its next match meanwhile.
  {
    let finish!: () => void;
    mkdirSync(path.join(media, "777001"));
    startRerender(777001, () => new Promise((r) => (finish = () => r({} as never))));
    // "Run now" is a press, not a schedule: it answers busy rather than waiting.
    const now = await runNightlyOnce("", { ranked: async () => [] });
    assert.equal(now.busy, true, `Run now refuses beside a re-render: ${JSON.stringify(now)}`);
    assert.equal(now.skipped, "a thumbnail re-render is running", "and says which");
    const run = runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [], scheduled: true });
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(nightlyStarting(), true, "the run is holding for the re-render");
    finish();
    const out = await run;
    assert.ok(!out.busy, `the run went ahead once the re-render was done: ${JSON.stringify(out)}`);
    assert.equal(nightlyStarting(), false);
    console.log("OK: the scheduled nightly waits out a thumbnail re-render");
  }

  // ...but not for ever: one still running once the wait is up is hung, and the night it costs is
  // recorded and pushed like any skip — not answered as "a render is already in flight", the
  // conflict that records nothing and tells nobody.
  {
    let finish!: () => void;
    mkdirSync(path.join(media, "777002"));
    startRerender(777002, () => new Promise((r) => (finish = () => r({} as never))));
    const out = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [],
      scheduled: true,
      thumbnailWaitMs: 100,
    });
    assert.equal(out.skipped, "a thumbnail re-render is still running", JSON.stringify(out));
    assert.ok(!out.busy, "not the silent conflict");
    assert.equal(readNightlyState()?.reason, "a thumbnail re-render is still running", "recorded");
    finish();
    console.log("OK: a hung re-render is a recorded skip, not a silent conflict");
  }
} finally {
  await rm(media, { recursive: true, force: true });
}

console.log("nightly: all checks passed");

// --- A chained skip must not overwrite the render it followed -------------------------------
// With nightlyMaxRenders raised, the second run of a night usually finds nothing left. That is
// the chain ending, not the night failing: the state file has to keep describing the render that
// actually happened, or the morning strip says the night was skipped when it rendered.
{
  // The blocks above tear their temp mediaDir down again, so make sure there is one to write into.
  mkdirSync(config.mediaDir, { recursive: true });
  const stateFile = path.join(config.mediaDir, ".nightly.json");
  const before = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
  try {
    writeNightlyState({
      startedAt: "2026-09-10T03:00:00.000Z",
      matchId: 4242,
      players: ["edcr", "doogile"],
      outcome: "done",
    });
    // started = 2: the chained run, with nothing eligible left.
    const out = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [] }, 2);
    assert.ok(out.skipped, "the chained run still reports that it found nothing");
    const after = JSON.parse(readFileSync(stateFile, "utf8")) as {
      lastRun: { outcome: string; matchId: number | null };
    };
    assert.equal(after.lastRun.outcome, "done", "the render's outcome survives the chained skip");
    assert.equal(after.lastRun.matchId, 4242, "and so does the match it rendered");
    console.log("OK: a chained skip leaves the night's real result standing");
  } finally {
    if (before === null) rmSync(stateFile, { force: true });
    else writeFileSync(stateFile, before);
  }
}

// --- restartWhenIdle.ts must see a chain as busy during the gap between two renders, not just
// while a job or an export is actually running -----------------------------------------------
// The gap: `ranked()`/`pickContext()` are network-bound and run with no job and no export yet
// started. Without `chainActive`, restartWhenIdle's idle() would read this moment as idle and
// could exit mid-chain (review fix, 8 Oct 2026).
{
  assert.equal(nightlyChainRunning(), false, "nothing running before this test starts");
  let duringRanked: boolean | null = null;
  const result = await runNightlyOnce(
    "",
    {
      renderInFlight: () => false,
      ranked: async () => {
        duringRanked = nightlyChainRunning();
        return [];
      },
    },
    1,
  );
  assert.equal(duringRanked, true, "set before the suggestion scan even resolves, not after");
  assert.ok(result.skipped, "nothing was found to render in this run");
  assert.equal(nightlyChainRunning(), false, "cleared once this run settled without starting a job");

  // A chained call (started > 1) that also finds nothing must not leave the flag stuck true
  // either — it is cleared by the same `skip`, whatever level of the chain called it.
  const chainedResult = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [] }, 2);
  assert.ok(chainedResult.skipped);
  assert.equal(nightlyChainRunning(), false, "a chained call's own skip clears the flag too");

  // An exception from the ranking step must not leave the flag stuck true for the rest of the
  // process either — the same guarantee `restartState().error` relies on in restartWhenIdle.ts.
  await assert.rejects(
    runNightlyOnce(
      "",
      {
        renderInFlight: () => false,
        ranked: async () => {
          throw new Error("boom");
        },
      },
      1,
    ),
    /boom/,
  );
  assert.equal(nightlyChainRunning(), false, "a thrown ranking step clears the flag too, not just skip()");
  console.log("OK: the nightly chain flag covers the network-bound gap, and always clears");
}
// A Run now answered 409 while a chain is in its gap (or the 03:00 timer firing during a Run now
// chain) starts and ends a chain of its own. With one boolean, that ending wiped the chain still in
// flight, and a restart armed for "when idle" could land before its next render (14 Oct 2026).
{
  let release: (picks: []) => void = () => {};
  let parked: () => void = () => {};
  const inRanked = new Promise<void>((resolve) => (parked = resolve));
  const chain = runNightlyOnce(
    "",
    {
      renderInFlight: () => false,
      ranked: () =>
        new Promise((resolve) => {
          release = resolve;
          parked();
        }),
    },
    1,
  );
  await inRanked;
  assert.equal(nightlyChainRunning(), true, "the chain is between renders");
  const runNow = await runNightlyOnce("", { renderInFlight: () => true });
  assert.equal(runNow.busy, true, "Run now is the 409");
  assert.equal(nightlyChainRunning(), true, "and its own ending leaves the chain in flight counted");
  release([]);
  assert.ok((await chain).skipped);
  assert.equal(nightlyChainRunning(), false, "the chain's own end clears it");
  console.log("OK: a 409'd Run now does not end the chain in flight");
}

// --- The pick does not wait on a stalled API ------------------------------------------------------
// The pairs the channel put out lately are looked up one at a time through a fetch with no timeout, so
// the unattended pick races that refresh against a deadline and goes on with the last snapshot.
{
  assert.equal(PAIR_POSTS_WAIT_MS, 15_000, "fifteen seconds");
  const logged: string[] = [];
  const quiet = console.error;
  console.error = (line: unknown) => {
    logged.push(String(line));
  };
  try {
    let finished = false;
    const stalled = () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          finished = true;
          resolve();
        }, 600),
      );
    const started = Date.now();
    await refreshPairPostsWithin(50, stalled);
    assert.ok(Date.now() - started < 500, "it gives up at the deadline, not when the refresh ends");
    assert.equal(finished, false, "the refresh is still running");
    assert.match(logged.join("\n"), /picking with the last answer/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(finished, true, "and it carries on in the background");

    // One that finishes in time returns at once and says nothing; one that fails does not reject the
    // pick either. (A 60 s timer left behind would hold this process open for a minute.)
    logged.length = 0;
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const quick = Date.now();
    await refreshPairPostsWithin(60_000, async () => {});
    assert.ok(Date.now() - quick < 500, "a refresh in time is not waited out");
    assert.deepEqual(logged, [], "and is not logged");
    assert.equal(timers(), before, "and leaves no deadline timer behind");
    await refreshPairPostsWithin(60_000, async () => {
      throw new Error("the media disk is gone");
    });
  } finally {
    console.error = quiet;
  }
  console.log("OK: the pick waits at most 15 s for the pairs the channel put out lately");
}

// --- The 18 Oct 2026 rules: sub-8 jump, diversity, evening coverage, the weekly mixed-pair cap ---
const sug = (matchId: number, players: [string, string], resultMs: number): Suggestion => ({
  metrics: {
    matchId,
    players,
    winner: players[0],
    resultMs,
    splits: [],
    finishMarginMs: null,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 0,
    maxLeadMs: 0,
    leadChanges: 0,
    panelLeadChanges: 0,
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
  },
  bucket: "close",
  score: 0,
  popularity: 0,
  profiles: players.map((nickname) => ({
    nickname,
    eloRank: null,
    elo: null,
    followers: null,
  })) as Suggestion["profiles"],
  h2h: null,
  vodUrls: [],
  dateSec: 0,
});

// --- isSubEightFinish / withSubEightJump: tier-independent, right after playoffs ----------------
{
  assert.equal(SUB_EIGHT_JUMP_MS, 8 * 60 * 1000, "8:00, named separately from recordPaceBoostSec");
  assert.equal(isSubEightFinish(8 * 60_000), true, "exactly 8:00 jumps");
  assert.equal(isSubEightFinish(8 * 60_000 + 1), false, "a millisecond over does not");
  assert.equal(isSubEightFinish(7 * 60_000), true);

  const slow1 = sug(1, ["a", "b"], 9 * 60_000);
  const fast1 = sug(2, ["c", "d"], 7 * 60_000);
  const slow2 = sug(3, ["e", "f"], 10 * 60_000);
  const fast2 = sug(4, ["g", "h"], 7.5 * 60_000);
  assert.deepEqual(
    withSubEightJump([slow1, fast1, slow2, fast2]).map((s) => s.metrics.matchId),
    [2, 4, 1, 3],
    "both sub-8 finishes move to the front, each group keeping its own relative order",
  );
  assert.deepEqual(
    withSubEightJump([slow1, slow2]).map((s) => s.metrics.matchId),
    [1, 3],
    "nothing sub-8: the order is untouched",
  );
  console.log("OK: isSubEightFinish/withSubEightJump — tier-independent, stable, 8:00 or under");
}

// --- excludeRenderedPairs: a chained render's own diversity filter -------------------------------
{
  const a = sug(1, ["Feinberg", "Infume"], 500_000);
  const b = sug(2, ["doogile", "edcr"], 500_000);
  const c = sug(3, ["Infume", "Feinberg"], 500_000); // same pair as a, reversed, different match
  assert.deepEqual(
    excludeRenderedPairs([a, b, c], new Set()).map((s) => s.metrics.matchId),
    [1, 2, 3],
    "nothing excluded with an empty set",
  );
  assert.deepEqual(
    excludeRenderedPairs([a, b, c], new Set(["feinberg|infume"])).map((s) => s.metrics.matchId),
    [2],
    "the pair already rendered tonight is dropped — either order, a different match id too",
  );
  console.log("OK: excludeRenderedPairs drops a pair by key, any order, any match id");
}

// --- openRankedSlots / eveningCoverageGap: pure, bounded, never negative ------------------------
{
  const HOUR = 3_600_000;
  const now = Date.parse("2026-10-18T10:00:00Z");
  const slot = (dateUtc: string) => Date.parse(`${dateUtc}T19:00:00Z`);
  assert.equal(
    openRankedSlots(now, 19, new Set()),
    2,
    "today's and tomorrow's 19:00 UTC both fall inside the next 48h and neither is claimed",
  );
  assert.equal(
    openRankedSlots(now, 19, new Set([slot("2026-10-18")])),
    1,
    "today's slot is claimed; tomorrow's is still open",
  );
  assert.equal(
    openRankedSlots(now, 19, new Set([slot("2026-10-18"), slot("2026-10-19")])),
    0,
    "both claimed: nothing open",
  );
  assert.equal(
    openRankedSlots(now, 19, new Set(), 20 * HOUR),
    1,
    "a horizon short of tomorrow's slot sees only today's",
  );
  assert.equal(EVENING_COVERAGE_MAX_PER_NIGHT, 3);
  assert.equal(eveningCoverageGap(2, 0), 2, "two open slots, nothing already waiting: a gap of 2");
  assert.equal(eveningCoverageGap(2, 2), 0, "plenty already waiting: no gap");
  assert.equal(eveningCoverageGap(1, 5), 0, "never negative");
  assert.equal(eveningCoverageGap(10, 0), EVENING_COVERAGE_MAX_PER_NIGHT, "capped at the nightly max");
  console.log("OK: openRankedSlots/eveningCoverageGap — pure, bounded, floored at 0");
}

// --- withinChainWindow: the window shouldChainNextRender already used, shared with coverage -----
{
  const night = at("2026-09-07T03:00:00Z");
  assert.equal(withinChainWindow(night, 3), true, "right at the hour");
  assert.equal(withinChainWindow(night + 3.9 * HOUR, 3), true);
  assert.equal(withinChainWindow(night + 4 * HOUR, 3), false, "the window has closed");
  assert.equal(withinChainWindow(night, null), false, "no schedule, no window");
  console.log("OK: withinChainWindow — shouldChainNextRender's own window, shared with coverage");
}

// --- isMixedKnownPick / the weekly cap on a mixed (one known, one unknown) pair -----------------
{
  const savedFav = config.favouritePlayers;
  config.favouritePlayers = ["doogile"];
  try {
    const bothKnown = {
      metrics: { matchId: 1, players: ["doogile", "Feinberg"] as [string, string] },
      bucket: "close",
    };
    const mixed = {
      metrics: { matchId: 2, players: ["doogile", "RandoOne"] as [string, string] },
      bucket: "close",
    };
    const bothUnknown = {
      metrics: { matchId: 3, players: ["RandoOne", "RandoTwo"] as [string, string] },
      bucket: "close",
    };
    const playoff = {
      metrics: { matchId: 4, players: ["RandoOne", "RandoTwo"] as [string, string] },
      bucket: "playoffs",
    };
    assert.equal(isMixedKnownPick(bothKnown), false, "both known: no cap");
    assert.equal(isMixedKnownPick(mixed), true, "exactly one known: mixed");
    assert.equal(isMixedKnownPick(bothUnknown), false, "neither known: not mixed (never eligible at all)");
    assert.equal(isMixedKnownPick(playoff), false, "a playoff pick is never mixed");

    const savedMedia = config.mediaDir;
    config.mediaDir = await mkdtemp(path.join(tmpdir(), "mcsr-nightly-mixedcap-"));
    try {
      const now = Date.now();
      assert.equal(knownUnknownRenderedRecently(now), false, "nothing recorded yet");
      recordKnownUnknownRender(now);
      assert.equal(knownUnknownRenderedRecently(now), true, "spent for the week");
      assert.equal(knownUnknownRenderedRecently(now + 6 * 86_400_000), true, "still inside 7 days");
      assert.equal(knownUnknownRenderedRecently(now + 7 * 86_400_000 + 1), false, "the week is up");

      const vodsAlways = async () => true;
      const eligible = nightlyEligible([], vodsAlways, now);
      assert.equal(await eligible(mixed), false, "a mixed pair is refused inside the 7 days");
      assert.equal(await eligible(bothKnown), true, "a both-known pair has no such cap");
      const queued = nightlyEligible([2], vodsAlways, now);
      assert.equal(await queued(mixed), true, "the operator's own queue still wins over the weekly cap");
    } finally {
      await rm(config.mediaDir, { recursive: true, force: true });
      config.mediaDir = savedMedia;
    }
  } finally {
    config.favouritePlayers = savedFav;
  }
  console.log("OK: isMixedKnownPick and the weekly cap — queue still wins, both-known is never capped");
}

// --- The 48 h pair cap (22 Oct 2026): no third video of one pair in the next 48 h of publish slots,
// unless the operator queued it; the rivalry boost puts the same few pairs on top every night ------
{
  assert.equal(PAIR_SLOTS_PER_48H, 2);
  const NOW = at("2026-10-22T03:00:00Z");
  const names: Record<number, [string, string]> = {
    1: ["Feinberg", "Infume"],
    2: ["Infume", "Feinberg"],
    3: ["Feinberg", "Infume"],
    4: ["lowk3y_", "silverrruns"],
  };
  const namesOf = async (id: number) => {
    if (id === 99) throw new Error("the API is down");
    return names[id] ?? null;
  };
  const times = (list: Array<[number, string]>) => async () => list.map(([id, iso]) => ({ id, ms: at(iso) }));
  const capped = async (list: Array<[number, string]>, tonight: string[] = []) =>
    [...(await pairsAtCap(NOW, new Set(tonight), times(list), namesOf))].sort();

  assert.deepEqual(
    await capped([
      [1, "2026-10-22T19:00:00Z"],
      [2, "2026-10-23T19:00:00Z"],
      [4, "2026-10-22T23:00:00Z"],
    ]),
    ["feinberg|infume"],
    "two of a pair in the next 48 h fill its share; one does not",
  );
  assert.deepEqual(
    await capped([
      [1, "2026-10-21T19:00:00Z"], // already out
      [2, "2026-10-22T19:00:00Z"],
      [3, "2026-10-24T19:00:00Z"], // past the 48 h
      [99, "2026-10-23T19:00:00Z"], // players unreadable: no constraint
      [4, "not a time"],
    ]),
    [],
    "only the slots ahead and inside 48 h count, and only a pair that can be read",
  );
  assert.deepEqual(
    await capped([
      [1, "2026-10-22T19:00:00Z"],
      [1, "2026-10-22T19:00:00Z"], // the record and Studio's schedule: one video
      [3, "2026-10-22T19:00:00Z"], // a series' game 2 on game 1's video: one slot
    ]),
    [],
    "one video counts once",
  );
  assert.deepEqual(
    await capped([[1, "2026-10-23T19:00:00Z"]], ["feinberg|infume", "doogile|edcr"]),
    ["feinberg|infume"],
    "a pair this chain rendered tonight takes a slot too",
  );

  // Through the pick: the cap drops an unqueued pick of a capped pair; the queue and the bracket are untouched.
  const savedMedia = config.mediaDir;
  config.mediaDir = await mkdtemp(path.join(tmpdir(), "mcsr-nightly-paircap-"));
  try {
    const full = new Set(["feinberg|infume"]);
    const vods = async () => true;
    const now = Date.now();
    const fi = sug(11, ["Feinberg", "Infume"], 600_000);
    const other = sug(12, ["doogile", "edcr"], 600_000);
    const bracket = { metrics: { matchId: 13, players: ["Infume", "Feinberg"] as [string, string] }, bucket: "playoffs" };
    const ctx = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 10 };
    assert.equal(await nightlyEligible([], vods, now, full)(fi), false, "a capped pair, unqueued: not tonight");
    assert.equal(await nightlyEligible([], vods, now, full)(other), true, "another pair is untouched");
    assert.equal(await nightlyEligible([], vods, now)(fi), true, "no cap read: nothing capped");
    assert.equal(await nightlyEligible([], vods, now, full)(bracket), true, "a playoff game goes out as is");
    assert.equal(
      (await pickNightlyCandidate([fi, other], ctx, nightlyEligible([], vods, now, full)))?.metrics.matchId,
      12,
      "the ranked list falls through to the next pair",
    );
    assert.equal(
      (await pickNightlyCandidate([other, fi], { ...ctx, queue: [11] }, nightlyEligible([11], vods, now, full)))
        ?.metrics.matchId,
      11,
      "the operator's queue (the Feinberg–Infume backlog) still renders, first",
    );
  } finally {
    await rm(config.mediaDir, { recursive: true, force: true });
    config.mediaDir = savedMedia;
  }
  console.log("OK: the 48 h pair cap — two slots a pair, tonight's renders count, the queue and the bracket untouched");
}
