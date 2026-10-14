// Self-check for videoStats: the uploads shelf asks for every match's video at once, and a
// series' games share one id. Past fifty ids videos.list answers 400 invalidFilters, which blanked
// every stat on the shelf (14 Oct 2026, 101 ids). Run: npx tsx src/youtube/videoStats.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-videostats-"));
process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);
const { videoStats } = await import("./youtube.js");

const calls: string[][] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  const ids = new URL(url).searchParams.get("id")!.split(",");
  calls.push(ids);
  if (ids.length > 50) return new Response("{}", { status: 400, statusText: "Bad Request" });
  return json({
    items: ids.map((id) => ({
      id,
      snippet: { title: id, publishedAt: "" },
      status: { privacyStatus: "public" },
      statistics: { viewCount: "1" },
    })),
  });
}) as typeof fetch;

// 101 ids, five of them one series' video: two batches, nothing asked twice, every video back.
const ids = [...Array.from({ length: 96 }, (_, i) => `v${i}`), ...Array(5).fill("series")];
const got = await videoStats(ids);
assert.deepEqual(
  calls.map((c) => c.length),
  [50, 47],
);
assert.equal(new Set(calls.flat()).size, calls.flat().length, "no id requested twice");
assert.equal(got.length, 97);
assert.deepEqual(await videoStats([]), []);
assert.equal(calls.length, 2, "no ids, no request");
console.log("videoStats: ok");
