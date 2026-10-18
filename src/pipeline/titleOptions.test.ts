// Self-check for titleOptions.ts's own control flow: the cache contract (so the Telegram message
// and auto-hooks see the same list) and the match-fetch failure path. The model-call branch is
// never exercised here — a cache hit returns before any `getMatch` or `claude` spawn — same
// reasoning as claude.test.ts: no real token spent in a unit test.
// Run: npx tsx src/pipeline/titleOptions.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-titleoptions-"));
config.mediaDir = media;

const unexpected: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  unexpected.push(String(input));
  return new Response("not here", { status: 404 });
}) as typeof fetch;

const { titleOptions } = await import("./titleOptions.js");

const dir = (id: number) => matchDir(id);
const cacheFile = (id: number) => path.join(dir(id), "title-options.json");

// A cache hit is returned verbatim, whatever it holds — no match fetch, no model call.
{
  const id = 1;
  mkdirSync(dir(id), { recursive: true });
  const seeded = { options: ["SKYCRAB vs LOWKEY"], source: ["nicknames"] as const };
  writeFileSync(cacheFile(id), JSON.stringify(seeded));
  const result = await titleOptions(id);
  assert.deepEqual(result, seeded, "a cache hit is returned as-is");
  assert.deepEqual(unexpected, [], "no fetch at all on a cache hit");
}

// A corrupt cache file is treated as missing, not thrown — falls through to a fresh build, which
// fails cleanly here because the match can't be read (fetch answers 404 above).
{
  const id = 2;
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(cacheFile(id), "not json");
  const result = await titleOptions(id);
  assert.deepEqual(result.options, []);
  assert.match(result.reason ?? "", /could not read the match/);
  // The failure is written back to the cache file, so a later non-fresh read sees the same thing
  // rather than retrying every call.
  const cached = JSON.parse(readFileSync(cacheFile(id), "utf8")) as typeof result;
  assert.deepEqual(cached, result, "the failure result is cached too");
}

// `fresh: true` bypasses even a good cache and rebuilds — still a clean failure here, same reason.
{
  const id = 1;
  const result = await titleOptions(id, { fresh: true });
  assert.deepEqual(result.options, []);
  assert.match(result.reason ?? "", /could not read the match/);
}

console.log("titleOptions: all checks passed");
