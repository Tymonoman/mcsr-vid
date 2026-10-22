// Pure-logic + file-IO self-check for the tc-plan importer (src/youtube/studioExperiments.ts).
// No browser, no network. Run: npx tsx src/youtube/studioExperiments.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  importTcPlan,
  planTcExperiments,
  resetTcExperiments,
  readExperiments,
  updateTcExperiments,
  writeExperiments,
  type Experiment,
  type ExperimentsFile,
  type TcPlan,
} from "./studioExperiments.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-experiments-"));
config.mediaDir = media;

// 0. readExperiments before any file exists at all defaults to empty, and a corrupt file is a
// throw, not a silent "no experiments" — a corrupt file from another writer mid-save must not be
// read as "nothing to re-plan/re-start" (both untested until now; every later test in this file
// writes `.experiments.json` before reading it).
{
  assert.ok(!existsSync(path.join(media, ".experiments.json")), "precondition: no file written yet");
  assert.deepEqual(
    await readExperiments(),
    { experiments: [], schedule: [] },
    "no file at all defaults to an empty experiments file",
  );

  writeFileSync(path.join(media, ".experiments.json"), "{not valid json");
  await assert.rejects(
    () => readExperiments(),
    /did not parse as JSON/,
    "a corrupt file throws rather than silently reading as empty",
  );
  console.log("OK: readExperiments defaults to empty with no file, and throws on a corrupt one");
}

function thumbPlan(): TcPlan {
  const dir = path.join(media, "111");
  mkdirSync(dir, { recursive: true });
  return {
    thumbnails: [
      {
        matchId: 111,
        videoId: "vid111",
        variants: [`${dir}/tc/tc-control.png`, `${dir}/tc/tc-pose.png`, `${dir}/tc/tc-caption.png`],
        approved: true,
      },
      // Not approved: must be skipped, never planned.
      {
        matchId: 222,
        videoId: "vid222",
        variants: [`${dir}/tc/tc-control.png`, `${dir}/tc/tc-caption.png`],
        approved: false,
      },
      // Fewer than 2 variants: skipped, never planned with a single arm.
      {
        matchId: 333,
        videoId: "vid333",
        variants: [`${dir}/tc/tc-control.png`],
        approved: true,
      },
    ],
  };
}

// 1. Approved thumbnail entry: every variant file is used exactly as given (8 Oct 2026 — the plan's
// own tc/ files are already final, judged renders, never rewritten to some other file on disk),
// and the non-approved / too-few-variants entries are skipped with a reason rather than silently
// dropped.
{
  const { added, skipped } = planTcExperiments(thumbPlan(), new Set());
  assert.equal(added.length, 1, `expected exactly one planned thumbnail experiment, got ${added.length}`);
  const exp = added[0]!;
  assert.equal(exp.id, "tc-thumbnail-vid111");
  assert.equal(exp.kind, "tc");
  assert.equal(exp.variable, "thumbnail");
  const files = exp.arms.map((a) => (a.settings as { file: string }).file);
  assert.deepEqual(
    files,
    [
      path.join(media, "111", "tc", "tc-control.png"),
      path.join(media, "111", "tc", "tc-pose.png"),
      path.join(media, "111", "tc", "tc-caption.png"),
    ],
    "every variant path used exactly as given, no rewrite",
  );
  assert.equal(skipped.length, 2, `expected 2 skips, got ${JSON.stringify(skipped)}`);
  assert.ok(skipped.some((s) => s.videoId === "vid222" && s.reason === "not approved"));
  assert.ok(skipped.some((s) => s.videoId === "vid333" && /fewer than 2 variants/.test(s.reason)));
  console.log("OK: thumbnail import uses every variant file as given, skips the rest with a reason");
}

// 2. Idempotent: an id already in the file is never re-added.
{
  const plan = thumbPlan();
  const first = planTcExperiments(plan, new Set());
  const second = planTcExperiments(plan, new Set(first.added.map((e) => e.id)));
  assert.equal(second.added.length, 0, "a second import of the same plan must add nothing");
  console.log("OK: an id already present is never re-planned");
}

// 3. Title entries: a hook that fails the same checks `startTestAndCompare` runs later is
// skipped per-variant; an entry where every variant fails is dropped entirely (never planned
// with zero challengers); exactly one challenger arm is ever planned (8 Oct 2026 — Title-only
// mode's own dialog has only one challenger slot), even when more than one variant would pass.
{
  const titlePlan: TcPlan = {
    titles: [
      {
        videoId: "vidT1",
        matchId: 444,
        live: "TEN SECONDS SHRANK TO ONE | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
        // The first fails (names the result), the second and third both pass: only the second —
        // the first to pass — becomes the challenger; the third is neither used nor logged.
        variants: ["DOOGILE WINS IT", "DECIDED BY 1 SECOND", "A SUB-9 TO WIN IT"],
        approved: true,
      },
      {
        videoId: "vidT2",
        matchId: 555,
        live: "SOME TITLE WITH NO NAMES",
        variants: ["ANYTHING"],
        approved: true,
      },
    ],
  };
  const { added, skipped } = planTcExperiments(titlePlan, new Set());
  assert.equal(added.length, 1, `expected one planned title experiment, got ${added.length}`);
  const exp = added[0]!;
  assert.equal(exp.id, "tc-title-vidT1");
  assert.equal(exp.arms.length, 2, "control + exactly one challenger, never more");
  assert.equal((exp.arms[0]!.settings as { title: string }).title, titlePlan.titles![0]!.live);
  assert.equal(
    (exp.arms[1]!.settings as { title: string }).title,
    "DECIDED BY 1 SECOND | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
    "the first variant to pass, not the last",
  );
  assert.ok(skipped.some((s) => s.videoId === "vidT1" && /gives the result away/.test(s.reason)));
  assert.ok(
    !skipped.some((s) => s.videoId === "vidT1" && /SUB-9/.test(s.reason)),
    "a passing variant past the first is silently unused, not logged as skipped",
  );
  assert.ok(skipped.some((s) => s.videoId === "vidT2" && /no "<a> vs <b>"/.test(s.reason)));
  console.log(
    "OK: a spoiler variant is dropped, only the first passing variant becomes the challenger, a title with no parseable names is skipped entirely",
  );
}

// 3b. A live title with no hook segment at all (splitTitle's `hook` is "") — `rest` must be the
// whole live line, not off by the separator's length, so the challenger title is the new hook
// plus the live line unchanged rather than a duplicated or truncated tail.
{
  const noHookPlan: TcPlan = {
    titles: [
      {
        videoId: "vidNoHook",
        matchId: 777,
        live: "edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
        variants: ["A SUB-9 TO WIN IT"],
        approved: true,
      },
    ],
  };
  const { added } = planTcExperiments(noHookPlan, new Set());
  assert.equal(added.length, 1);
  assert.equal(
    (added[0]!.arms[1]!.settings as { title: string }).title,
    "A SUB-9 TO WIN IT | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
    "a hookless live title gets the new hook prefixed onto the unchanged line, not duplicated or offset",
  );
  console.log("OK: planTcExperiments handles a live title with no existing hook segment");
}

// 4. IO: importTcPlan never drops a `between` entry, the engine's own top-level fields
// (`baseline`/`appliedOn`/`evaluatedOn`), or any other field already in the file — read-merge-write,
// not overwrite (review fix, 8 Oct 2026: the old `readExperiments`/`writeExperiments` reconstructed
// `{ experiments, schedule }` only and silently dropped everything else on every write).
{
  const betweenExperiment = {
    id: "between-publish-hour",
    kind: "between",
    hypothesis: "a later publish hour gets more engaged views",
    variable: "publishHourUtc",
    metric: "engagedViews",
    controlArm: "19utc",
    arms: [
      { name: "19utc", settings: { publishHourUtc: 19 } },
      { name: "21utc", settings: { publishHourUtc: 21 } },
    ],
    videos: [{ videoId: "abc123", matchId: 999, arm: "19utc" }],
    start: "2026-10-01",
    end: "2026-10-15",
    status: "running",
    needsHumanAck: false,
  };
  const existing: ExperimentsFile = {
    baseline: { publishHourUtc: 19, introSec: 7 },
    experiments: [betweenExperiment as unknown as Experiment],
    schedule: [{ note: "untouched" }],
    appliedOn: "2026-10-07",
    evaluatedOn: "2026-10-07",
  };
  await writeExperiments(existing);
  const betweenBefore = JSON.stringify(betweenExperiment);

  const { added } = await importTcPlan({
    titles: [
      {
        videoId: "vidT3",
        matchId: 666,
        live: "A SUB-9 TO WIN IT | lauveer vs edcr | MCSR Ranked 1v1 | Minecraft Speedrun",
        variants: ["DECIDED BY 9.1 SECONDS"],
        approved: true,
      },
    ],
  });
  assert.equal(added.length, 1);

  const onDisk = JSON.parse(await readFile(path.join(media, ".experiments.json"), "utf8")) as ExperimentsFile;
  assert.equal(onDisk.experiments.length, 2, "the between entry must survive the tc import");
  const betweenAfter = onDisk.experiments.find((e) => e.id === "between-publish-hour");
  assert.ok(betweenAfter, "the between entry must survive the tc import");
  assert.equal(JSON.stringify(betweenAfter), betweenBefore, "the between entry survives byte-for-byte");
  assert.deepEqual(onDisk.schedule, [{ note: "untouched" }], "schedule untouched");
  assert.deepEqual(onDisk.baseline, { publishHourUtc: 19, introSec: 7 }, "baseline untouched");
  assert.equal(onDisk.appliedOn, "2026-10-07", "appliedOn untouched — the engine's once-a-day guard");
  assert.equal(onDisk.evaluatedOn, "2026-10-07", "evaluatedOn untouched — the engine's once-a-day guard");
  console.log(
    "OK: importing tc experiments leaves between entries, schedule, baseline, appliedOn and evaluatedOn untouched",
  );

  // A second import of the same plan is a no-op on disk, confirming the file-level idempotency.
  const again = await importTcPlan({
    titles: [
      {
        videoId: "vidT3",
        matchId: 666,
        live: "A SUB-9 TO WIN IT | lauveer vs edcr | MCSR Ranked 1v1 | Minecraft Speedrun",
        variants: ["DECIDED BY 9.1 SECONDS"],
        approved: true,
      },
    ],
  });
  assert.equal(again.added.length, 0);
  const stillTwo = await readExperiments();
  assert.equal(stillTwo.experiments.length, 2);
  assert.equal(stillTwo.appliedOn, "2026-10-07", "appliedOn still untouched after a second import");
  console.log("OK: re-importing the same plan writes nothing new to disk");
}

// 4b. readExperiments/writeExperiments round-trip every unknown top-level field directly, even
// with no `tc` entries involved at all — the exact shape `applyScheduledRenderArm`
// (`src/dashboard/experiments.ts`) itself writes and rereads nightly.
{
  const full: ExperimentsFile = {
    baseline: { introSec: 7, explainMovesSec: null },
    experiments: [],
    schedule: [{ date: "2026-10-09", experimentId: "between-x", arm: "a" }],
    appliedOn: "2026-10-08",
    evaluatedOn: "2026-10-08",
  };
  await writeExperiments(full);
  const read = await readExperiments();
  assert.deepEqual(read, full, "every top-level field round-trips exactly, nothing dropped");
  console.log(
    "OK: readExperiments/writeExperiments round-trip baseline/appliedOn/evaluatedOn with zero tc traffic",
  );
}

// 5. updateTcExperiments is a cross-process-safe critical section: two concurrent callers (the
// standalone worker and a one-off CLI invocation run alongside it, in this process modelled as
// two concurrent calls) each adding their own experiment must both land — neither read-merge-write
// may interleave with the other and silently drop one caller's addition.
{
  await writeExperiments({ experiments: [], schedule: [] });
  const expOf = (id: string): Experiment => ({
    id,
    kind: "tc",
    arms: [{ name: "control" }],
    videos: [],
    status: "planned",
  });
  await Promise.all([
    updateTcExperiments((tc) => [...tc, expOf("race-a")]),
    updateTcExperiments((tc) => [...tc, expOf("race-b")]),
  ]);
  const after = await readExperiments();
  const ids = after.experiments.map((e) => e.id);
  assert.ok(ids.includes("race-a") && ids.includes("race-b"), `both concurrent writes must land, got ${ids}`);
  assert.equal(after.experiments.length, 2, "neither write may be lost to the other");
  console.log("OK: two concurrent updateTcExperiments calls serialize — neither one's write is lost");
}

// 6. updateTcExperiments's own contract, directly: `mutate` sees only `kind: "tc"` entries, never
// a `between` one mixed in — test 4 only ever checked this indirectly, through importTcPlan.
{
  await writeExperiments({
    experiments: [
      { id: "between-only", kind: "between", arms: [], videos: [], status: "running" } as unknown as Experiment,
    ],
    schedule: [],
  });
  let sawKinds: string[] = [];
  await updateTcExperiments((tc) => {
    sawKinds = tc.map((e) => e.kind);
    return tc;
  });
  assert.deepEqual(sawKinds, [], "mutate's own tc list excludes the between entry entirely");
  const after6 = await readExperiments();
  assert.equal(after6.experiments.length, 1, "the between entry is untouched and still there");
  console.log("OK: updateTcExperiments hands mutate only the tc-kind entries");
}

// 7. withExperimentsLock recovers from a stale lock left by a crashed holder (its own process
// died between creating the lockfile and reaching the `finally` that removes it) — the crash
// path a cooperating-process lock exists for, untested until now. Age is computed from the
// lockfile's own mtime, so this needs no real 30s wait.
{
  await writeExperiments({ experiments: [], schedule: [] });
  const lockFile = path.join(media, ".experiments.json.lock");
  writeFileSync(lockFile, "");
  const longAgo = new Date(Date.now() - 40_000);
  utimesSync(lockFile, longAgo, longAgo);

  const result = await updateTcExperiments((tc) => [
    ...tc,
    { id: "after-stale-lock", kind: "tc", arms: [{ name: "control" }], videos: [], status: "planned" },
  ]);
  assert.ok(
    result.experiments.some((e) => e.id === "after-stale-lock"),
    "the write succeeds once the stale (30s+) lock is broken, not wedged forever",
  );
  assert.ok(!existsSync(lockFile), "the lock file is removed again after this write's own critical section");
  console.log("OK: a stale lock from a crashed holder is broken and retried, not a permanent wedge");
}

console.log("studioExperiments: all checks passed");

// 5. resetTcExperiments: a done experiment goes back to planned with its result gone; running/planned untouched.
{
  await updateTcExperiments((tc) => [
    ...tc,
    { id: "tc-reset-done", kind: "tc", variable: "thumbnail", arms: [{ name: "a" }, { name: "b" }], videos: [{ videoId: "vR1", matchId: 1, arm: "tc" }], status: "done", start: null, end: "2026-10-22T09:46:00.000Z", result: { watchTimeShare: { a: 1 } }, verdict: "old", needsHuman: "x" },
    { id: "tc-reset-running", kind: "tc", variable: "thumbnail", arms: [{ name: "a" }, { name: "b" }], videos: [{ videoId: "vR2", matchId: 2, arm: "tc" }], status: "running", start: "2026-10-20T00:00:00.000Z" },
  ]);
  const { reset, skipped } = await resetTcExperiments(["tc-reset-done", "tc-reset-running", "tc-reset-missing"]);
  assert.deepEqual(reset, ["tc-reset-done"]);
  assert.deepEqual(skipped, ["tc-reset-running", "tc-reset-missing"]);
  const after = (await readExperiments()).experiments;
  const done = after.find((e) => e.id === "tc-reset-done");
  assert.equal(done?.status, "planned");
  assert.equal(done?.start, null);
  assert.equal(done?.end, null);
  assert.ok(!("result" in done!) && !("verdict" in done!) && !("needsHuman" in done!), "result, verdict and needsHuman are gone");
  assert.equal(after.find((e) => e.id === "tc-reset-running")?.status, "running", "a running experiment tracks a live test — untouched");
  console.log("OK: resetTcExperiments puts a done tc experiment back to planned and leaves a running one alone");
}
