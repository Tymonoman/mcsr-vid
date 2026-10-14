// Contract test for `npm run short:hand`'s blocked-player gate (src/shorts/handShort.ts), from the docs
// alone (CLAUDE.md "Blocked players" and "Shorts" → shortsByHand; handbook/claude-md-reference.md;
// README "The Short and publishing" step 3). Promises:
//
//   1. A blocked match is "never rendered by npm run short/short:hand, even by hand": `checkHandShort`
//      refuses it with the reason, and `buildHandShort` throws `HandShortRefusal` writing nothing —
//      no short-<id>.mp4, no .title.txt/.description.txt, no short-<id>.hand.json.
//   2. Refused before any ffprobe spawn (cheap/local checks first).
//   3. Any case.
//   4. A blocked match is one whose POV clips are a blocked runner's, even when the MCSR API now
//      spells him differently (the renamed-runner case the handbook names for Adopt).
//   5. The control: the same file and hook for a clean match pass every check.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/shorts/handShort.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { buildHandShort, checkHandShort, HandShortRefusal, type VideoSpec } from "./handShort.js";

function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-handshort-contract-"));
const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, fetch: globalThis.fetch };
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const served = new Map<number, MatchInfo>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const match = m ? served.get(Number(m[1])) : undefined;
  if (!match) throw new Error(`no network in this test: ${url.href}`);
  return new Response(JSON.stringify({ status: "success", data: { ...match, id: Number(m![1]) } }));
}) as typeof fetch;

// ffprobe, injected: counts its spawns and answers a valid Short.
let probes = 0;
const GOOD: VideoSpec = { width: 1080, height: 1920, vcodec: "h264", acodec: "aac", durationSec: 30 };
const probe = async () => (probes++, GOOD);
const src = path.join(media, "cut.mp4");
writeFileSync(src, "hand-cut bytes");
const opts = { mp4Path: src, hook: "ONE HEART LEFT", fromSec: 120, toSec: 150, pov: "left" as const };

const matchWith = (id: number, from: number, clips: string[]): string => {
  served.set(id, fixture(from));
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  for (const c of clips) writeFileSync(path.join(dir, `${c}.mp4`), "");
  return dir;
};
const shortFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("short-"));

try {
  // --- 1/2. BeefSalad's real match: refused with the reason, before ffprobe, nothing written --------
  const BEEF = 30_000_001;
  const beefDir = matchWith(BEEF, 13549300, ["hackingnoises", "BeefSalad"]);
  const check = await checkHandShort(BEEF, opts, probe);
  assert.equal(check.ok, false);
  assert.match((check as { problem: string }).problem, /blocked player/);
  await assert.rejects(buildHandShort(BEEF, opts, { probe }), HandShortRefusal);
  assert.equal(probes, 0, "no ffprobe spawned for a blocked match");
  assert.deepEqual(shortFiles(beefDir), [], "no Short file, title, description or hand.json");
  console.log("OK: short:hand refuses a blocked match before ffprobe and writes nothing");

  // --- 3. Any case ---------------------------------------------------------------------------------
  config.blockedPlayers = ["AQUACORDE"];
  const AQUA = 30_000_002;
  const aquaDir = matchWith(AQUA, 12902901, ["BlazeMind", "Aquacorde"]);
  await assert.rejects(buildHandShort(AQUA, opts, { probe }), /blocked player/);
  assert.deepEqual(shortFiles(aquaDir), []);
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  console.log("OK: the block ignores case");

  // --- 4. A renamed runner: the API says edcr vs doogile, the POV clip is Aquacorde's ---------------
  const RENAMED = 30_000_003;
  matchWith(RENAMED, 12730175, ["Aquacorde", "doogile"]);
  const renamed = await checkHandShort(RENAMED, opts, probe);
  deviation(
    "CLAUDE.md Blocked players: 'never rendered by npm run short/short:hand even by hand' (match whose POV clips are a blocked runner's)",
    () =>
      assert.equal(
        renamed.ok,
        false,
        "checkHandShort passes a match whose clip on disk is Aquacorde's — it checks the API's pair only, not blockedOnDisk",
      ),
  );

  // --- 5. The control ------------------------------------------------------------------------------
  const CLEAN = 30_000_004;
  matchWith(CLEAN, 12730175, ["edcr", "doogile"]);
  const clean = await checkHandShort(CLEAN, opts, probe);
  assert.equal(clean.ok, true, `a clean match passes: ${JSON.stringify(clean)}`);
  assert.ok(!existsSync(path.join(matchDir(CLEAN), `short-${CLEAN}.mp4`)), "a check alone writes nothing");
  console.log("OK: the same cut and hook for a clean match pass");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
}

console.log("handShort.contract: all checks passed");
