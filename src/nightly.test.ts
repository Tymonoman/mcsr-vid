// Self-check for nightly.ts. The scheduler runs unattended at 03:00 UTC, so the two decisions
// nobody will be awake to correct — *when* it fires and *what* it picks — are pinned here.
// The timer itself is not tested: that would be a test of setTimeout.
// Run: npx tsx src/nightly.test.ts
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  chainExport,
  chainShort,
  type ExportStarter,
  msUntilNextRun,
  pickNightlyCandidate,
  playoffPicks,
  playoffsWithoutVods,
  playoffVodsReady,
  readNightlyState,
  runNightlyOnce,
  shouldChainNextRender,
  writeNightlyState,
} from "./nightly.js";
import type { PlayoffBoard } from "./playoffs.js";
import type { MatchInfo } from "./types.js";
import type { ShortRunner } from "./shortsRoutes.js";

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

// --- The bracket's games, in front and in series order, only when the operator has asked. The
// default is off: a config default that changes what tonight's nightly renders is not ours to set.
{
  const seed = (nickname: string) => ({ uuid: nickname, nickname, label: "LCQ", seasonEloRate: 2000 });
  const board: PlayoffBoard = {
    season: 11,
    slots: [
      {
        id: 9,
        round: "Round of 16",
        bestOf: 5,
        startTime: 0,
        seeds: [seed("edcr"), seed("lauveer")],
        games: [
          { matchId: 3, dateSec: 300, gameNo: 3 },
          { matchId: 1, dateSec: 100, gameNo: 1 },
          { matchId: 2, dateSec: 200, gameNo: 2 },
        ],
      },
    ],
  };
  let loads = 0;
  const load = async () => (loads++, board);

  assert.equal(config.playoffsFirst, false, "off by default; the operator flips it for a tournament");
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
  config.playoffsFirst = false;
}

// --- Whether the night ends with a Short. The spawn is injected: the real one is a full render,
// and this is a test of the decision, not of ffmpeg.
{
  const spawned: Array<{ matchId: number; pick: number }> = [];
  const runner =
    (code: number): ShortRunner =>
    (matchId, pick) => {
      spawned.push({ matchId, pick });
      const proc = new EventEmitter() as ChildProcess;
      // The close listener is attached after the runner returns, so it cannot fire synchronously.
      setImmediate(() => proc.emit("close", code));
      return proc;
    };

  assert.equal(await chainShort(1, "done", true, runner(0)), " + Short rendered");
  // The flag is the whole point of the flag.
  assert.equal(await chainShort(2, "done", false, runner(0)), "");
  // An abort is the operator saying stop, and a failed render may have left nothing to cut from;
  // neither is a licence to spend the rest of the night on a Short.
  assert.equal(await chainShort(3, "aborted", true, runner(0)), "");
  assert.equal(await chainShort(4, "failed: ffmpeg died", true, runner(0)), "");
  assert.deepEqual(
    spawned,
    [{ matchId: 1, pick: 0 }],
    "only a clean render with the flag on may spawn, and always the top moment",
  );

  // A Short that fails does not turn a rendered match into a failure — it is a clause, not a
  // verdict, and the notification has to carry both halves.
  assert.match(await chainShort(5, "done", true, runner(1)), /Short failed/);
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
    skipped: "every candidate is processed, hidden or without VODs, or the disk is full",
  });
  assert.equal(readNightlyState()?.outcome, "skipped", "an ordinary skip is recorded, with its reason");
  assert.equal(
    readNightlyState()?.reason,
    "every candidate is processed, hidden or without VODs, or the disk is full",
  );
  assert.equal(readNightlyState()?.matchId, null, "a skip chose nothing, so it names nothing");
  // No list at all is a different sentence — a cold process with a dead API, not a full disk.
  const none = await runNightlyOnce("", { renderInFlight: () => false, ranked: async () => null });
  assert.deepEqual(none, { skipped: "no suggestions available" });

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
      skipped: "every candidate is processed, hidden or without VODs, or the disk is full (no VOD: #2)",
    });
  }
} finally {
  await rm(media, { recursive: true, force: true });
}

console.log("nightly: all checks passed");
