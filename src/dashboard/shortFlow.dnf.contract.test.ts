// Contract test: a DNF never gets hooks saved, by hand or by auto-hooks (the operator, 16 Oct 2026:
// "remember not to post DNF matches also dont suggest them"). Saved hooks are what start the chain
// whose end is an upload, so a DNF that gets none never goes up. Written from the rule:
//  1. Save on a DNF is refused with one line saying why; nothing is written and the chain never runs.
//  2. Auto-hooks passes a due DNF by: no hooks saved, nothing rendered or uploaded.
//  3. A finished match with the same files is unaffected, by hand and by auto-hooks.
// The MCSR API is a fake serving real fixtures (one made a forfeit); the render and the upload are
// stand-ins. Nothing leaves the process.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/shortFlow.dnf.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import type { ShortPick } from "../shorts/shortPlan.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
process.env.MCSR_ARCHIVE_DIR ??= path.join(media, "archive");
const saved = { config: { ...config }, fetch: globalThis.fetch };
config.mediaDir = media;
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";
config.youtubePlaylistTitle = "";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const SAVE_DNF = 21_000_001;
const SAVE_OK = 21_000_002;
const AUTO_DNF = 21_000_003;
const AUTO_OK = 21_000_004;
const dnfs = new Set([SAVE_DNF, AUTO_DNF]);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) {
    const id = Number(m[1]);
    // The shape 13303909 has on the live API: forfeited, a winner on record, no completion.
    const over = dnfs.has(id) ? { forfeited: true, completions: [] } : {};
    return ok({ ...fixture, changes: [], id, ...over });
  }
  const u = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (u) {
    const p = fixture.players.find((x) => x.uuid === u[1])!;
    return ok({
      uuid: p.uuid,
      nickname: p.nickname,
      eloRate: 2000,
      eloRank: 5,
      country: "us",
      statistics: {},
    });
  }
  return new Response("not here", { status: 404 });
}) as typeof fetch;

const flow = await import("./shortFlow.js");

const NOW = Date.parse("2026-10-14T08:00:00Z");
const HOUR = 3600_000;
const dir = (id: number) => path.join(media, String(id));
/** Exported and picked: everything a Save or auto-hooks needs, the hooks aside. */
function ready(id: number, pickedAt = NOW): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
  );
  const final = path.join(dir(id), `final-${id}.mp4`);
  writeFileSync(final, "x");
  utimesSync(final, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  writeFileSync(path.join(dir(id), `match-${id}.title.txt`), "<HOOK> | edcr vs doogile | MCSR Ranked 1v1\n");
  const pick: ShortPick = {
    gameMatchId: id,
    startMs: 300_000,
    endMs: 330_000,
    pov: "both",
    focus: "left",
    hookSuggestion: "Down to the last heart",
    why: "a stand-in",
    kind: "play",
    source: "agy",
    createdAt: new Date(pickedAt).toISOString(),
  };
  writeFileSync(path.join(dir(id), `short-${id}.pick.json`), JSON.stringify(pick));
}
const edited = (id: number) => existsSync(path.join(dir(id), `match-${id}.title.edited.txt`));
const hookFile = (id: number) => existsSync(path.join(dir(id), `short-${id}.hook.txt`));

/** What the chain did, per match: a render or an upload of a DNF must never appear here. */
const events: string[] = [];
const of = (id: number) => events.filter((e) => e.endsWith(`:${id}`));
const deps: Partial<import("./shortFlow.js").ChainDeps> = {
  render: async (id) => (events.push(`render:${id}`), "stand-in render"),
  upload: (async (id: number) => (events.push(`upload:${id}`), { status: 409, error: "stand-in" })) as never,
  pick: async (id) => void events.push(`pick:${id}`),
  refreshChannel: async () => {},
  resumeUpload: async () => "unexpected resume",
  now: () => NOW,
};

try {
  // --- 1/3. Save by hand -----------------------------------------------------------------------------
  ready(SAVE_DNF);
  ready(SAVE_OK);
  const body = { titleHook: "Who blinks first?", shortHook: "DOWN TO THE LAST HEART" };
  const refused = await flow.saveHooks(SAVE_DNF, body, deps);
  await flow.chainIdle(SAVE_DNF);
  assert.ok(refused && "status" in refused, `a DNF's Save is refused: ${JSON.stringify(refused)}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.error, `match ${SAVE_DNF} is a DNF (nobody finished) — hooks cannot be saved for it`);
  assert.ok(!edited(SAVE_DNF) && !hookFile(SAVE_DNF), "nothing is written");
  assert.equal(flow.readStatus(SAVE_DNF).hooksSavedAt, undefined, "no save is recorded");
  assert.deepEqual(of(SAVE_DNF), [], "the chain never runs");

  const accepted = await flow.saveHooks(SAVE_OK, body, deps);
  await flow.chainIdle(SAVE_OK);
  assert.ok(!(accepted && "status" in accepted), `a finished match saves: ${JSON.stringify(accepted)}`);
  assert.ok(edited(SAVE_OK) && hookFile(SAVE_OK), "its hooks are on disk");
  assert.ok(flow.readStatus(SAVE_OK).hooksSavedAt, "and recorded");
  console.log(
    "OK: Save is refused for a DNF with one line, nothing written, no chain; a finished match saves",
  );

  // --- 2/3. Auto-hooks -------------------------------------------------------------------------------
  config.autoHooksAfterHours = 6;
  ready(AUTO_DNF, NOW - 7 * HOUR);
  ready(AUTO_OK, NOW - 7 * HOUR);
  await flow.autoHooksTick(deps, NOW);
  await flow.chainIdle(AUTO_DNF);
  await flow.chainIdle(AUTO_OK);
  const dnf = flow.readStatus(AUTO_DNF);
  assert.equal(dnf.hooksSavedAt, undefined, "auto-hooks saves nothing for a due DNF");
  assert.equal(dnf.autoHooks, undefined);
  assert.ok(!edited(AUTO_DNF) && !hookFile(AUTO_DNF), "no hook file is written");
  assert.deepEqual(of(AUTO_DNF), [], "nothing rendered, nothing uploaded");
  assert.ok(flow.readStatus(AUTO_OK).hooksSavedAt, "the finished match due beside it is saved");
  assert.ok(edited(AUTO_OK), "with its title hook on disk");
  console.log("OK: auto-hooks never saves a DNF's hooks; the finished match beside it is saved");
} finally {
  Object.assign(config, saved.config);
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("shortFlow.dnf.contract: all checks passed");
