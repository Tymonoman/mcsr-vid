// Contract test for the Studio worker and the block list (`planCycle` with its real `isBlocked`,
// src/youtube/studioWorker.ts), from the docs alone (CLAUDE.md "Blocked players" — `blockedOnDisk`
// reads clips, chats and the title "so a match archived off disk is still caught (the Studio worker's
// `realIsBlocked` … share[s] this check)"; handbook/claude-md-reference.md "Studio automation": "the
// same disk-only check every other Studio action already uses", "a blocked match (`isBlocked`) gets
// neither a pin nor an end screen"). Promises:
//
//   1. With the worker's own default check, an archived blocked match (clips gone, the title still
//      naming him) gets no end screen, no pin, no thumbnail Test & Compare plan, no related-video link.
//   2. Every Studio action gates on it — so a Test & Compare already planned for a blocked match is
//      not started either.
//   3. The control: the same records for a clean match are planned for every action.
// No browser: `planCycle` is the pure planner `runCycle` hands its targets from.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/youtube/studioWorker.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS, matchDir } from "../config.js";
import type { Experiment } from "../dashboard/experiments.js";
import { planCycle, type LongFormRef, type StudioLedger } from "./studioWorker.js";

const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers };
const media = mkdtempSync(path.join(tmpdir(), "mcsr-studio-contract-"));
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];

const BLOCKED = 80_000_001;
const CLEAN = 80_000_002;
// Archived: no clips, no chats, only the generated title naming the pair.
for (const [id, pair] of [
  [BLOCKED, "hackingnoises vs BeefSalad"],
  [CLEAN, "edcr vs doogile"],
] as const) {
  mkdirSync(matchDir(id), { recursive: true });
  writeFileSync(
    path.join(matchDir(id), `match-${id}.title.txt`),
    `WHO BLINKS FIRST? | ${pair} | MCSR Ranked 1v1 | Minecraft Speedrun\n`,
  );
}

const longForm = (matchId: number): LongFormRef => ({
  videoId: `LF${matchId}`.slice(0, 11),
  matchId,
  uploadedAt: "2026-10-12T19:00:00.000Z", // after every cutoff
  privacyStatus: "public",
  publishAt: null,
  source: "dashboard",
  finishedComment: null, // the comment posted (before the block) …
  finishedPin: undefined, // … the pin never tried
});
const ledger: StudioLedger = { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} };
const plannedTc = (matchId: number): Experiment =>
  ({
    id: `tc-${matchId}`,
    kind: "tc",
    status: "planned",
    videos: [{ matchId, videoId: `LF${matchId}`.slice(0, 11) }],
    arms: [],
  }) as unknown as Experiment;
const NOW = new Date("2026-10-14T12:00:00Z");
const ids = (rows: readonly { matchId: number }[]) => rows.map((r) => r.matchId);

try {
  const plan = planCycle(
    NOW,
    [longForm(BLOCKED), longForm(CLEAN)],
    ledger,
    [],
    undefined, // the worker's own realIsBlocked
    [
      { matchId: BLOCKED, videoId: "SHORTblockd" },
      { matchId: CLEAN, videoId: "SHORTcleanx" },
    ],
  );
  // --- 1/3. Archived blocked match: none of the four actions; the clean one gets all four ----------
  assert.deepEqual(ids(plan.endScreenTargets), [CLEAN], "no end screen on a blocked runner's video");
  assert.deepEqual(ids(plan.pinTargets), [CLEAN], "no pin on a blocked runner's video");
  assert.deepEqual(ids(plan.thumbnailTcTargets), [CLEAN], "no thumbnail test planned for it");
  assert.deepEqual(ids(plan.relatedLinkTargets), [CLEAN], "its Short is not linked");
  console.log("OK: the worker's own check keeps an archived blocked match out of every new Studio action");

  // --- 2. A Test & Compare planned before the block --------------------------------------------------
  const withTc = planCycle(NOW, [longForm(BLOCKED), longForm(CLEAN)], ledger, [
    plannedTc(BLOCKED),
    plannedTc(CLEAN),
  ]);
  const started = withTc.tcToStart.map((e) => e.videos[0]!.matchId);
  assert.ok(started.includes(CLEAN), "the clean match's planned test starts (the control)");
  assert.ok(!started.includes(BLOCKED), `a planned test on a blocked runner's video never starts: ${JSON.stringify(started)}`);
  console.log("OK: a Test & Compare planned before the block is not started");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  rmSync(media, { recursive: true, force: true });
}

console.log("studioWorker.contract: all checks passed");
