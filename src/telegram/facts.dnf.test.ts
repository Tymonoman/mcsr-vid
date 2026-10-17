// Self-check for the morning report's one DNF line (Needs-you): a DNF in tonight's queue is skipped
// by the nightly every night and only the operator takes it out, so it is named, once; a finished
// queued match is not. The MCSR and YouTube APIs are fakes; nothing leaves the process.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/telegram/facts.dnf.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { setNightlyQueue } from "../dashboard/matchShelf.js";
import { gatherFacts } from "./facts.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-facts-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = { mediaDir: config.mediaDir, fetch: globalThis.fetch, token: process.env.YOUTUBE_TOKEN_FILE };
config.mediaDir = media;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const DNF = 24_000_001;
const FINISHED = 24_000_002;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (data: unknown) => new Response(JSON.stringify(data));
  const m = /^https:\/\/api\.mcsrranked\.com\/matches\/(\d+)$/.exec(url);
  if (m) {
    const id = Number(m[1]);
    const over = id === DNF ? { forfeited: true, completions: [] } : {};
    return json({ status: "success", data: { ...fixture, id, ...over } });
  }
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/commentThreads?") || url.includes("/videos?")) return json({ items: [] });
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

try {
  const NOW = Date.parse("2026-10-16T05:00:00Z");
  setNightlyQueue([DNF, FINISHED]);
  const facts = await gatherFacts(NOW, NOW - 86_400_000, ["needsYou"]);
  assert.ok(facts.needsYou.ok, JSON.stringify(facts.needsYou));
  const items = facts.needsYou.ok ? facts.needsYou.data.items : [];
  assert.deepEqual(
    items.filter((i) => i.matchId === DNF).map((i) => i.text),
    ["a DNF (nobody finished) in tonight's queue — the nightly skips it"],
    "the queued DNF is named once",
  );
  assert.deepEqual(
    items.filter((i) => i.matchId === FINISHED),
    [],
    "the finished queued match is not",
  );
  console.log("OK: Needs-you names a DNF in tonight's queue, once, and not a finished queued match");
} finally {
  config.mediaDir = saved.mediaDir;
  globalThis.fetch = saved.fetch;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  rmSync(media, { recursive: true, force: true });
}

console.log("facts.dnf: all checks passed");
