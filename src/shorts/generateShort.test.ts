// Self-check for generateShort.ts's hand-mode gate (`config.shortsByHand`, 11 Oct 2026): with the
// setting on, `npm run short` refuses before the pick is read, so a hand-cut Short and its
// title/description are never overwritten by a model cut behind the dead dashboard hook. With the
// setting off, a leftover `short-<id>.hand.json` blocks nothing: the CLI goes on to its next gate
// (here, the missing sync.json). It spawns the CLI the way `npm run short` does. No API is reached,
// because both runs stop before the match record is read.
// Run: npx tsx src/shorts/generateShort.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-genshort-"));
const id = 13_000_090;
const dir = path.join(media, String(id));
mkdirSync(dir, { recursive: true });
const file = (suffix: string) => path.join(dir, `short-${id}${suffix}`);
writeFileSync(file(".hook.txt"), "DEAD HOOK\n");
writeFileSync(
  file(".pick.json"),
  JSON.stringify({ gameMatchId: id, startMs: 60_000, endMs: 90_000, pov: "left", focus: "left" }),
);
writeFileSync(file(".mp4"), "hand-cut stand-in");
writeFileSync(file(".title.txt"), "HAND HOOK | a vs b\n");
writeFileSync(file(".hand.json"), JSON.stringify({ hook: "HAND HOOK" }));

const run = (shortsByHand: boolean) => {
  const configPath = path.join(media, `config-${shortsByHand}.json`);
  writeFileSync(configPath, JSON.stringify({ mediaDir: media, shortsByHand }));
  return spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "src", "shorts", "generateShort.ts"), String(id)],
    { env: { ...process.env, MCSR_CONFIG: configPath }, encoding: "utf8", timeout: 60_000 },
  );
};

const on = run(true);
assert.equal(on.status, 1, on.stderr);
assert.match(on.stderr, /waiting for the hand-made Short/);
assert.equal(readFileSync(file(".mp4"), "utf8"), "hand-cut stand-in", "the hand cut is untouched");
assert.equal(readFileSync(file(".title.txt"), "utf8"), "HAND HOOK | a vs b\n", "its title too");
console.log("OK: npm run short refuses in hand mode");

const off = run(false);
assert.equal(off.status, 1, off.stderr);
assert.doesNotMatch(off.stderr, /hand-made Short/, "the setting alone decides, never a leftover hand.json");
assert.match(off.stderr, /no sync\.json/);
console.log("OK: with the setting off, a leftover hand.json blocks nothing");
