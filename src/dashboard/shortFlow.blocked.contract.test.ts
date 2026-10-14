// Contract test for the hooks gate of "Blocked players" (`saveHooks`, src/dashboard/shortFlow.ts), from
// the docs alone (CLAUDE.md "Blocked players" and "Shorts"; handbook/claude-md-reference.md). The
// API-pair refusal, its case rule, the clean control and the saved-chat disk case are pinned by
// shortFlow.contract.test.ts (C11); this file adds the one case it leaves open:
//
//   A blocked match is a match with a blocked runner on it — the POV clips on disk name him even when
//   the MCSR API now spells him differently (the renamed-runner case the handbook gives for Adopt) —
//   so a blocked match "never gets hooks saved" holds for a match whose own clips are his.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/shortFlow.blocked.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { chainIdle, saveHooks, type ChainDeps } from "./shortFlow.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-contract-"));
const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, fetch: globalThis.fetch };
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];

// The MCSR API serves a real match (edcr vs doogile) under the test id; nothing else answers.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (!m) throw new Error(`no network in this test: ${url.href}`);
  return new Response(
    JSON.stringify({ status: "success", data: { ...fixture, id: Number(m[1]), changes: [] } }),
  );
}) as typeof fetch;

// The chain's every side effect, recorded: none of these may run for a blocked match.
const calls: string[] = [];
const deps: Partial<ChainDeps> = {
  pick: async (id) => void calls.push(`pick ${id}`),
  render: async (id) => (calls.push(`render ${id}`), null),
  upload: (async (id: number) => (
    calls.push(`upload ${id}`),
    { status: 403, error: "stub" }
  )) as ChainDeps["upload"],
  refreshChannel: async () => calls.push("refresh"),
  resumeUpload: async (id) => (calls.push(`resume ${id}`), null),
};

try {
  // A renamed runner: the API says edcr vs doogile, the POV clip on disk is Aquacorde's.
  const RENAMED = 40_000_003;
  const dir = matchDir(RENAMED);
  mkdirSync(dir, { recursive: true });
  for (const f of ["Aquacorde.mp4", "doogile.mp4", `final-${RENAMED}.mp4`])
    writeFileSync(path.join(dir, f), "");
  const renamed = await saveHooks(
    RENAMED,
    { titleHook: "WHO BLINKS FIRST?", shortHook: "ONE HEART LEFT" },
    deps,
  );
  await chainIdle(RENAMED);
  // CLAUDE.md Blocked players: a blocked match 'never gets hooks saved' (match whose POV clips are a blocked runner's)
  assert.ok(
    renamed !== null &&
      "status" in renamed &&
      renamed.status === 403 &&
      /blocked player/.test(renamed.error),
    `saveHooks answered ${JSON.stringify(renamed)} and the chain ran [${calls.join(", ")}] — the clips on disk (blockedOnDisk) must block it, not just the API's pair`,
  );
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("shortFlow.blocked.contract: all checks passed");
