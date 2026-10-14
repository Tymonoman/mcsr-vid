// Contract test for `npm run short:hand`'s blocked-player gate (src/shorts/handShort.ts), from the docs
// alone (CLAUDE.md "Blocked players" and "Shorts" → shortsByHand; handbook/claude-md-reference.md).
// handShort.contract.test.ts P7/P16 pins the refusal itself (whole-string, case-insensitive) and that
// `checkHandShort` refuses before its probe; this file adds what it leaves open:
//
//   1. `buildHandShort` — the CLI's own path — refuses a blocked match before any ffprobe spawn and
//      writes no short-* file.
//   2. A blocked match is one whose POV clips are a blocked runner's, even when the MCSR API now
//      spells him differently (the renamed-runner case the handbook names for Adopt).
// Run: MCSR_CONFIG=/nonexistent npx tsx src/shorts/handShort.blocked.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { buildHandShort, checkHandShort, HandShortRefusal, type VideoSpec } from "./handShort.js";

// A doc promise the code does not keep: printed and listed, never fatal (main's contract files' way).
const deviations: string[] = [];
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
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

try {
  // --- 1. BeefSalad's real match, through buildHandShort: refused before ffprobe, nothing written ---
  const BEEF = 30_000_001;
  const beefDir = matchWith(BEEF, 13549300, ["hackingnoises", "BeefSalad"]);
  await assert.rejects(
    buildHandShort(BEEF, opts, { probe }),
    (err: unknown) => err instanceof HandShortRefusal && /blocked player/.test((err as Error).message),
  );
  assert.equal(probes, 0, "no ffprobe spawned for a blocked match");
  assert.deepEqual(
    readdirSync(beefDir).filter((f) => f.startsWith("short-")),
    [],
    "no Short file, title, description or hand.json",
  );
  console.log("OK: buildHandShort refuses a blocked match before ffprobe and writes nothing");

  // --- 2. A renamed runner: the API says edcr vs doogile, the POV clip is Aquacorde's ---------------
  const RENAMED = 30_000_003;
  matchWith(RENAMED, 12730175, ["Aquacorde", "doogile"]);
  const renamed = await checkHandShort(RENAMED, opts, probe);
  deviation(
    "CLAUDE.md Blocked players: 'never rendered by npm run short/short:hand even by hand' (match whose POV clips are a blocked runner's)",
    () =>
      assert.match(
        renamed.ok ? "" : renamed.problem,
        /blocked player/,
        `checkHandShort answered ${renamed.ok ? "ok" : JSON.stringify(renamed.problem)} for a match whose clip on disk is Aquacorde's — it checks the API's pair only, not blockedOnDisk`,
      ),
  );
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

if (deviations.length) console.log(`${deviations.length} deviation(s) from the docs — see DEVIATION lines`);
console.log("handShort.blocked.contract: all checks passed");
