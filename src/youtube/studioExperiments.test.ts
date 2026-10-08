// Pure-logic + file-IO self-check for the tc-plan importer (src/youtube/studioExperiments.ts).
// No browser, no network. Run: npx tsx src/youtube/studioExperiments.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  importTcPlan,
  planTcExperiments,
  readExperiments,
  writeExperiments,
  type ExperimentsFile,
  type TcPlan,
} from "./studioExperiments.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-experiments-"));
config.mediaDir = media;

function thumbPlan(): TcPlan {
  const dir = path.join(media, "111");
  mkdirSync(dir, { recursive: true });
  return {
    thumbnails: [
      {
        matchId: 111,
        videoId: "vid111",
        variants: [`${dir}/tc/tc-control.png`, `${dir}/tc/tc-pose.png`],
        approved: true,
        note: "Pose challenger is walking-crossed: no celebration.",
      },
      // Not approved: must be skipped, never planned.
      {
        matchId: 222,
        videoId: "vid222",
        variants: [`${dir}/tc/tc-control.png`, `${dir}/tc/tc-caption.png`],
        approved: false,
      },
      // A pose challenger whose note names no known pose: the whole entry is skipped, not
      // half-imported with a guessed file.
      {
        matchId: 333,
        videoId: "vid333",
        variants: [`${dir}/tc/tc-control.png`, `${dir}/tc/tc-pose.png`],
        approved: true,
        note: "no pose named here",
      },
    ],
  };
}

// 1. Approved thumbnail entry: the pose challenger is rewritten off tc/ to the strip file, the
// control (not a pose challenger) passes through unchanged, and the non-approved / unresolvable
// entries are skipped with a reason rather than silently dropped.
{
  const { added, skipped } = planTcExperiments(thumbPlan(), new Set());
  assert.equal(added.length, 1, `expected exactly one planned thumbnail experiment, got ${added.length}`);
  const exp = added[0]!;
  assert.equal(exp.id, "tc-thumbnail-vid111");
  assert.equal(exp.kind, "tc");
  assert.equal(exp.variable, "thumbnail");
  const files = exp.arms.map((a) => (a.settings as { file: string }).file);
  assert.equal(files[0], path.join(media, "111", "tc", "tc-control.png"), "control path untouched");
  assert.equal(
    files[1],
    path.join(media, "111", "thumbnail.walking-crossed.png"),
    "pose challenger rewritten off tc/ to the strip file",
  );
  assert.equal(skipped.length, 2, `expected 2 skips, got ${JSON.stringify(skipped)}`);
  assert.ok(skipped.some((s) => s.videoId === "vid222" && s.reason === "not approved"));
  assert.ok(skipped.some((s) => s.videoId === "vid333" && /no known pose/.test(s.reason)));
  console.log("OK: thumbnail import rewrites only the pose challenger, skips the rest with a reason");
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
// with zero challengers), and the surviving variant becomes a real challenger arm.
{
  const titlePlan: TcPlan = {
    titles: [
      {
        videoId: "vidT1",
        matchId: 444,
        live: "TEN SECONDS SHRANK TO ONE | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
        variants: ["DECIDED BY 1 SECOND", "DOOGILE WINS IT"], // the second names the result
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
  assert.equal(exp.arms.length, 2, "control + exactly the one surviving challenger");
  assert.equal((exp.arms[0]!.settings as { title: string }).title, titlePlan.titles![0]!.live);
  assert.equal(
    (exp.arms[1]!.settings as { title: string }).title,
    "DECIDED BY 1 SECOND | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
  );
  assert.ok(skipped.some((s) => s.videoId === "vidT1" && /gives the result away/.test(s.reason)));
  assert.ok(skipped.some((s) => s.videoId === "vidT2" && /no "<a> vs <b>"/.test(s.reason)));
  console.log("OK: a spoiler variant is dropped, a title with no parseable names is skipped entirely");
}

// 4. IO: importTcPlan never drops a `between` entry or an unrelated top-level field already in
// the file — read-merge-write, not overwrite.
{
  const existing: ExperimentsFile = {
    experiments: [
      {
        id: "between-publish-hour",
        kind: "between",
        arms: [{ name: "19utc" }, { name: "21utc" }],
        videos: [],
        status: "running",
      },
    ],
    schedule: [{ note: "untouched" }],
  };
  await writeExperiments(existing);

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
  assert.ok(onDisk.experiments.some((e) => e.id === "between-publish-hour" && e.status === "running"));
  assert.deepEqual(onDisk.schedule, [{ note: "untouched" }]);
  console.log("OK: importing tc experiments leaves between entries and schedule untouched");

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
  console.log("OK: re-importing the same plan writes nothing new to disk");
}

console.log("studioExperiments: all checks passed");
