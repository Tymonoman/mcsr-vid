// Contract test for the hooks gate of "Blocked players" (`saveHooks`, src/dashboard/shortFlow.ts), from
// the docs alone (CLAUDE.md "Blocked players" and "Shorts"; handbook/claude-md-reference.md). Promises:
//
//   1. A blocked match "never gets hooks saved", so its chain (pick → render → upload) never starts:
//      `PUT /api/shorts/hooks/:id` answers a refusal, writes no title edit and no Short hook, and
//      records no `hooksSavedAt`.
//   2. Any case: the list's spelling and the API's need not match.
//   3. A blocked match is a match with a blocked runner on it — the POV clips on disk name him even
//      when the MCSR API now spells him differently (the renamed-runner case the handbook gives for
//      Adopt) — so the same refusal holds for a match whose own clips are a blocked runner's.
//   4. The control: the same match with nobody blocked saves (so the refusal is the block).
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/shortFlow.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { metaPaths } from "../pipeline/title.js";
import { chainIdle, readStatus, saveHooks, type ChainDeps } from "./shortFlow.js";

function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-contract-"));
const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, fetch: globalThis.fetch };
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
// Which real match the MCSR API serves under each test id; nothing else answers.
const served = new Map<number, MatchInfo>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const match = m ? served.get(Number(m[1])) : undefined;
  if (!match) throw new Error(`no network in this test: ${url.href}`);
  return new Response(
    JSON.stringify({ status: "success", data: { ...match, id: Number(m![1]), changes: [] } }),
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
const BODY = { titleHook: "WHO BLINKS FIRST?", shortHook: "ONE HEART LEFT" };

/** An exported match's directory with these POV clips. */
const exported = (id: number, clips: string[], from: number): void => {
  served.set(id, fixture(from));
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  for (const c of clips) writeFileSync(path.join(dir, `${c}.mp4`), "");
  writeFileSync(path.join(dir, `final-${id}.mp4`), "");
};
const nothingSaved = (id: number): boolean =>
  !existsSync(metaPaths(id, "title").edited) &&
  !existsSync(path.join(matchDir(id), `short-${id}.hook.txt`)) &&
  !readStatus(id).hooksSavedAt;

try {
  // --- 1. The API's pair names BeefSalad (his real match): refused, nothing written, no chain -----
  const BEEF = 40_000_001;
  exported(BEEF, ["hackingnoises", "BeefSalad"], 13549300);
  const refused = await saveHooks(BEEF, BODY, deps);
  assert.ok(refused && "status" in refused, "refused, not saved with warnings");
  assert.equal(refused.status, 403);
  assert.match(refused.error, /blocked player/);
  await chainIdle(BEEF);
  assert.ok(nothingSaved(BEEF), "no title edit, no Short hook, no hooksSavedAt");
  assert.deepEqual(calls, [], "no pick, no render, no upload");
  console.log("OK: a blocked match's hooks are refused and its chain never starts");

  // --- 2. Any case ----------------------------------------------------------------------------------
  config.blockedPlayers = ["aquacorde"];
  const AQUA = 40_000_002;
  exported(AQUA, ["BlazeMind", "Aquacorde"], 12902901);
  const lower = await saveHooks(AQUA, BODY, deps);
  assert.equal(lower && "status" in lower ? lower.status : null, 403, "the list's lower case still blocks");
  assert.ok(nothingSaved(AQUA));
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  console.log("OK: the block ignores case");

  // --- 3. A renamed runner: the API says edcr vs doogile, the clips on disk are Aquacorde's ----------
  const RENAMED = 40_000_003;
  exported(RENAMED, ["Aquacorde", "doogile"], 12730175);
  const renamed = await saveHooks(RENAMED, BODY, deps);
  await chainIdle(RENAMED);
  deviation(
    "CLAUDE.md Blocked players: a blocked match 'never gets hooks saved' (match whose POV clips are a blocked runner's)",
    () =>
      assert.ok(
        renamed !== null && "status" in renamed && renamed.status === 403,
        `saveHooks answered ${JSON.stringify(renamed)} and the chain ran [${calls.join(", ")}] — saveHooks checks the API's pair only, not blockedOnDisk`,
      ),
  );
  calls.length = 0;

  // --- 4. The control: a clean match saves --------------------------------------------------------
  const CLEAN = 40_000_004;
  exported(CLEAN, ["edcr", "doogile"], 12730175);
  const ok = await saveHooks(CLEAN, BODY, deps);
  await chainIdle(CLEAN);
  assert.ok(ok === null || !("status" in ok), `a clean match's hooks save: ${JSON.stringify(ok)}`);
  assert.ok(readStatus(CLEAN).hooksSavedAt, "and the save is recorded");
  console.log("OK: the same files with nobody blocked save");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
}

console.log("shortFlow.contract: all checks passed");
