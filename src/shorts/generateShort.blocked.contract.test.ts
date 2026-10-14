// Contract test for `npm run short`'s blocked-player gate (src/shorts/generateShort.ts, a CLI), from the
// docs alone (CLAUDE.md "Blocked players": a blocked match is "never rendered by `npm run short` …
// even by hand"; handbook/claude-md-reference.md, same bullet). Promises:
//
//   1. Run by hand on a blocked runner's match with everything else in place — the saved Short hook,
//      the pick, the sync — the CLI exits non-zero with the block as its reason.
//   2. Nothing is cut: no short-<id>.mp4, no title/description/cut files.
//   3. Any case.
// It spawns the CLI the way `npm run short` does (tsx), with its own config file and the MCSR API
// stubbed by a preloaded fetch that serves BeefSalad's real match; nothing else answers.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/shorts/generateShort.contract.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-genshort-contract-"));
const id = 13_549_300; // BeefSalad's real match (src/fixtures/match-13549300.json)
const dir = path.join(media, String(id));
mkdirSync(dir, { recursive: true });
// Everything `npm run short` asks for before it reads the match: the hook, the pick, the sync.
writeFileSync(path.join(dir, `short-${id}.hook.txt`), "ONE HEART LEFT\n");
writeFileSync(
  path.join(dir, `short-${id}.pick.json`),
  JSON.stringify({ gameMatchId: id, startMs: 120_000, endMs: 150_000, pov: "left", focus: "left" }),
);
writeFileSync(
  path.join(dir, "sync.json"),
  JSON.stringify({ left: 12, right: 12, confidence: 1, detail: "test", source: "manual" }),
);
for (const clip of ["hackingnoises.mp4", "BeefSalad.mp4"]) writeFileSync(path.join(dir, clip), "");

// The child's fetch: the fixture for /matches/<id>, a refusal for anything else (no network).
const mock = path.join(media, "mock-fetch.mjs");
const fixturePath = fileURLToPath(new URL("../fixtures/match-13549300.json", import.meta.url));
writeFileSync(
  mock,
  `import { readFileSync } from "node:fs";
const match = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
globalThis.fetch = async (input) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.mcsrranked.com" && url.pathname === "/matches/${id}")
    return new Response(JSON.stringify({ status: "success", data: match }));
  throw new Error("no network in this test: " + url.href);
};
`,
);

const run = (blockedPlayers: string[]) => {
  const configPath = path.join(media, "config.json");
  writeFileSync(configPath, JSON.stringify({ mediaDir: media, shortsByHand: false, blockedPlayers }));
  return spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "src", "shorts", "generateShort.ts"), String(id)],
    {
      env: { ...process.env, MCSR_CONFIG: configPath, NODE_OPTIONS: `--import=${mock}` },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
};
const shortFiles = () =>
  readdirSync(dir).filter((f) => f.startsWith(`short-${id}`) && !/\.(hook\.txt|pick\.json)$/.test(f));

const cli = run(["beefsalad"]); // any case
assert.equal(cli.status, 1, `exit status: ${cli.status}\n${cli.stderr}`);
assert.match(cli.stderr, /blocked player/, "the block is the reason given — every earlier gate was passed");
assert.deepEqual(shortFiles(), [], "nothing cut: no Short, no title, no description, no cut record");
console.log("OK: npm run short refuses a blocked runner's match, run by hand with everything in place");

console.log("generateShort.contract: all checks passed");
