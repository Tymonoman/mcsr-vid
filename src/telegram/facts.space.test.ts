// Self-check for spaceAlarmItem's low-disk Needs-you line (19 Oct 2026, the automatic NAS-sweep
// disk alarm): it must say nothing while free space is comfortably above config.spaceAlarmGb,
// and name the free space plus what the next sweep would recover once it isn't. No network beyond
// the Data API's own videoStats call, which this stubs the same way facts.dnf.test.ts does.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/telegram/facts.space.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { spaceAlarmItem } from "./facts.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-facts-space-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = {
  mediaDir: config.mediaDir,
  spaceAlarmGb: config.spaceAlarmGb,
  fetch: globalThis.fetch,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = media;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (data: unknown) => new Response(JSON.stringify(data));
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/videos?")) return json({ items: [] }); // no uploads here anyway — allUploads() is empty
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

try {
  // Real statfs on a real tmp dir: free space is whatever the box reports, never negative or
  // infinite, so 0 and a very large threshold are the two deterministic ends of the comparison —
  // no fixture has to fake an exact byte count.
  config.spaceAlarmGb = 0;
  assert.equal(await spaceAlarmItem(), null, "comfortably above a 0 GB alarm — nothing to say");

  config.spaceAlarmGb = 10_000_000; // no real box has 10 PB free
  const item = await spaceAlarmItem();
  assert.ok(item, "well under a huge alarm threshold — the line fires");
  assert.match(item!.text, /^disk: \d+(\.\d+)? GB free on .+; the next NAS sweep frees about 0\.0 GB$/);
  console.log("OK: spaceAlarmItem is silent above the threshold and names the free/recoverable GB below it");
} finally {
  config.mediaDir = saved.mediaDir;
  config.spaceAlarmGb = saved.spaceAlarmGb;
  globalThis.fetch = saved.fetch;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  rmSync(media, { recursive: true, force: true });
}

console.log("facts.space: all checks passed");
