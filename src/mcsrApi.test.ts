// getMatch's TTL cache, against a stubbed global fetch as playlist.test.ts does — never the
// network. Run: npx tsx src/mcsrApi.test.ts
import assert from "node:assert/strict";
import { getMatch } from "./mcsrApi.js";

let calls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  calls++;
  const url = String(input);
  assert.match(url, /\/matches\/\d+$/, `unexpected fetch: ${url}`);
  return new Response(JSON.stringify({ status: "success", data: { id: Number(url.split("/").pop()) } }));
}) as typeof fetch;

const realNow = Date.now;
try {
  assert.equal((await getMatch(1)).id, 1);
  await getMatch(1);
  assert.equal(calls, 1, "the second read within the TTL is the cached record");
  await getMatch(2);
  assert.equal(calls, 2, "a different match is its own fetch");

  // Past the TTL the record is fetched again: players attach VODs after the game, and the
  // pipeline's VOD guard must see them.
  Date.now = () => realNow() + 11 * 60_000;
  assert.equal((await getMatch(1)).id, 1);
  assert.equal(calls, 3, "an entry older than ten minutes is refetched");

  // A failed fetch caches nothing, so the retry is a real request.
  globalThis.fetch = (async () => {
    calls++;
    return new Response("nope", { status: 503, statusText: "down" });
  }) as typeof fetch;
  await assert.rejects(getMatch(3), /503/);
  await assert.rejects(getMatch(3), /503/);
  assert.equal(calls, 5, "an error is not cached");
  console.log("mcsrApi: all checks passed");
} finally {
  Date.now = realNow;
}
