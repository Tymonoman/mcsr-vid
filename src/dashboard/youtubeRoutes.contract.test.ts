// Contract test for the adopt route's sync gate, written from the docs (CLAUDE.md "Known
// pitfalls": a sync.json correction after export leaves the published video out of sync until
// re-exported; `exportStale` refuses Upload/nightly/adopt with one line) by an outside engineer.
// Upload's own refusal is already pinned in src/youtube/youtubeUpload.test.ts; this is adopt's.
// Every Google call is caught by a mocked fetch: nothing leaves the box.
// Run: npx tsx src/dashboard/youtubeRoutes.contract.test.ts
//
// Promises covered (numbering shared with src/dashboard/syncRoutes.contract.test.ts):
//  P8  A sync.json correction after export leaves the export stale until re-encoded.
//  P9  exportStale refuses adopt (`POST /api/youtube/adopt/:id`) with one line — before anything
//      reaches YouTube — and stops refusing once the export is re-encoded.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { staleExportMessage, syncFilePath, writeSyncOffsets } from "../pipeline/syncFile.js";
import { handleYoutubeRoute } from "./youtubeRoutes.js";

const ID = 12730175; // edcr vs doogile (src/fixtures)
const fixture = readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8");
const media = mkdtempSync(path.join(tmpdir(), "adopt-sync-contract-"));
config.mediaDir = media;
// "Connected" with a token that cannot work anywhere: isConfigured() only checks the file.
const savedToken = process.env.YOUTUBE_TOKEN_FILE;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
writeFileSync(process.env.YOUTUBE_TOKEN_FILE, JSON.stringify({ refresh_token: "not-a-token" }));

const google: string[] = [];
const elsewhere: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.mcsrranked.com" && url.pathname === `/matches/${ID}`)
    return new Response(`{"status":"success","data":${fixture}}`);
  (url.hostname.endsWith("googleapis.com") ? google : elsewhere).push(String(url));
  throw new Error(`no network in a contract test: ${url}`);
}) as typeof fetch;

const parseId = (raw: string | undefined): number | null =>
  raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;

async function adopt(videoId: string): Promise<{ status: number; body: { error?: string } }> {
  const out = { status: 0, body: {} as { error?: string } };
  const url = `/api/youtube/adopt/${ID}`;
  await handleYoutubeRoute(
    { method: "POST", url } as IncomingMessage,
    {} as ServerResponse,
    url.split("/").filter(Boolean),
    {
      json: (_res, status, body) => {
        out.status = status;
        out.body = body as { error?: string };
      },
      readBody: async () => JSON.stringify({ videoId }),
      matchDir,
      parseId,
    },
  );
  return out;
}

const dir = matchDir(ID);
mkdirSync(dir, { recursive: true });
// Everything adopt checks before the sync gate, in order: a hook in the title, a description that
// pairs, a thumbnail variant the operator confirmed. No result, no label: the match's own names.
writeFileSync(
  path.join(dir, `match-${ID}.title.edited.txt`),
  "Does the lead ever settle? | edcr vs doogile | MCSR Ranked 1v1\n",
);
writeFileSync(
  path.join(dir, `match-${ID}.description.edited.txt`),
  `edcr and doogile, both POVs side by side.\nhttps://magmamcsr.com/ranked/player/edcr/matches/${ID}\n`,
);
writeFileSync(
  path.join(dir, "thumbnail.json"),
  JSON.stringify({ chosenBy: "operator", variants: [], hookText: null }),
);
const final = path.join(dir, `final-${ID}.mp4`);
writeFileSync(final, "the export");
const at = (file: string, ms: number) => utimesSync(file, new Date(ms), new Date(ms));
const now = Date.now();

try {
  // P8: exported at -60 s, the sync fixed by hand at -30 s — the export is behind its sync.
  at(final, now - 60_000);
  writeSyncOffsets(dir, { left: 153.25, right: 148.5, confidence: 1, detail: "", source: "manual" });
  at(syncFilePath(dir), now - 30_000);

  const refused = await adopt("abcdefghijk");
  // P9: refused with the one shared line, naming the re-export — the same words the Upload button
  // and the nightly get, so the operator learns one fix.
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, staleExportMessage(ID));
  assert.ok(!refused.body.error!.includes("\n"), "one line");
  // Before anything reaches YouTube: adopt REPLACES a live video's title and description, so a
  // stale export must stop it before the first read, let alone the write.
  assert.deepEqual(google, [], "no Google call for a stale export");
  assert.equal(existsSync(path.join(dir, "youtube.json")), false, "no record written");

  // P8/P9: re-encoded after the fix — the sync gate opens (the route goes on to ask YouTube about
  // the video; the mocked fetch refuses that, which is the route's own error, not the stale one).
  at(final, now);
  const fresh = await adopt("abcdefghijk");
  assert.notEqual(fresh.body.error, staleExportMessage(ID), "no longer refused as stale");
  assert.ok(google.length > 0, "past the sync gate: YouTube is asked (and the mock answers no)");
} finally {
  if (savedToken === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = savedToken;
  rmSync(media, { recursive: true, force: true });
}

assert.deepEqual(elsewhere, [], "nothing else was asked for");
console.log("youtubeRoutes.contract: all checks passed");
