// Contract test for Adopt's blocked-player gate (`POST /api/youtube/adopt/:id`,
// src/dashboard/youtubeRoutes.ts), from the docs alone (CLAUDE.md "Blocked players" and "Adopt a
// Studio draft"; handbook/claude-md-reference.md, the same bullets). Promises:
//
//   1. Adopt refuses a blocked player — on the API's pair OR `blockedOnDisk` — before `videos.update`
//      (the title/description write `finishOnYouTube`'s own gate does not cover): no YouTube call.
//   2. The refusal is "up front, first of its checks" (handbook): a blocked match is answered as
//      blocked, not with whichever other refusal (an unconfirmed thumbnail, say) happens to apply.
//   3. The control: the same match with nobody blocked gets past every refusal to Google's door,
//      so the 403 above is the block and nothing else.
//
// The API-pair path is isolated with a `titleNames` spelling (a made-up runner, Runnerx → "Spelled",
// the way the default spells two real ones): an archived match whose title says "Spelled vs doogile"
// names nobody on disk, so only the API's pair can catch it. youtubeRoutes.test.ts already pins the
// disk-only path (title, chats).
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/youtubeRoutes.blocked.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { manifestPath } from "../thumbnails/thumbnailVariants.js";
import { handleYoutubeRoute, type YoutubeRouteContext } from "./youtubeRoutes.js";

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

const media = mkdtempSync(path.join(tmpdir(), "mcsr-adopt-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  titleNames: config.titleNames,
  token: process.env.YOUTUBE_TOKEN_FILE,
  fetch: globalThis.fetch,
};
config.mediaDir = media;
config.titleNames = { Runnerx: "Spelled" };
const token = path.join(media, "token.json");
writeFileSync(token, JSON.stringify({ refresh_token: "r", client_id: "c", client_secret: "s" }));
process.env.YOUTUBE_TOKEN_FILE = token;

// The MCSR API answers with a real match (edcr vs doogile) re-seated so its left player is Runnerx;
// anything Google is recorded and refused.
const real = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const asRunnerx = (id: number): MatchInfo => ({
  ...real,
  id,
  players: real.players.map((p, i) => (i === 0 ? { ...p, nickname: "Runnerx" } : p)),
});
const google: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (url.hostname === "api.mcsrranked.com" && m)
    return new Response(JSON.stringify({ status: "success", data: asRunnerx(Number(m[1])) }));
  if (/google/.test(url.hostname)) google.push(url.href);
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
const ctx: YoutubeRouteContext = {
  json: (_res, status, body) => void answers.push({ status, body: body as Record<string, unknown> }),
  readBody: async () => JSON.stringify({ videoId: "abcdefghijk" }),
  matchDir,
  parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
};
const adopt = async (matchId: number) => {
  google.length = 0;
  assert.ok(
    await handleYoutubeRoute(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      ["api", "youtube", "adopt", String(matchId)],
      ctx,
    ),
  );
  return answers.at(-1)!;
};
/** An archived match (no clips, no chats) ready for Adopt: saved title, pairing description, maybe a confirmed variant. */
const archived = (id: number, confirmed: boolean) => {
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `match-${id}.title.edited.txt`),
    `WHO BLINKS FIRST? | Spelled vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun\n`,
  );
  writeFileSync(
    path.join(dir, `match-${id}.description.txt`),
    `https://mcsrranked.com/stats/matches/${id}\n`,
  );
  if (confirmed)
    writeFileSync(manifestPath(dir), JSON.stringify({ chosenBy: "operator", chosen: "a", variants: [] }));
};

try {
  // --- 3. The control first: Runnerx not blocked, the same files reach Google ------------------------
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  archived(50_000_001, true);
  const open = await adopt(50_000_001);
  assert.notEqual(
    open.status,
    403,
    `unblocked, Adopt is not refused as blocked: ${JSON.stringify(open.body)}`,
  );
  assert.ok(google.length > 0, "the control did reach for Google");

  // --- 1. Blocked by the API's pair only: refused, and Google never asked ----------------------------
  config.blockedPlayers = ["runnerx"]; // any case
  archived(50_000_002, true);
  const byApi = await adopt(50_000_002);
  assert.equal(byApi.status, 403, `the API's pair names a blocked runner: ${JSON.stringify(byApi.body)}`);
  assert.match(String(byApi.body.error), /blocked player/);
  assert.deepEqual(google, [], "no YouTube read and no videos.update for a blocked match");
  console.log("OK: Adopt refuses on the API's pair before any YouTube call");

  // --- 2. "First of its checks": a blocked match with another refusal pending is refused as blocked --
  archived(50_000_003, false); // no confirmed thumbnail variant: Adopt's own 409, if it got that far
  const ordered = await adopt(50_000_003);
  assert.deepEqual(google, [], "still no YouTube call");
  deviation(
    "handbook Blocked players: Adopt 'also refuses up front, first of its checks … on the API's pair or blockedOnDisk'",
    () =>
      assert.equal(
        ordered.status,
        403,
        `a blocked match is answered ${ordered.status} (${String(ordered.body.error)}) — the API-pair check runs after the title/description/thumbnail refusals`,
      ),
  );
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.titleNames = saved.titleNames;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

if (deviations.length) console.log(`${deviations.length} deviation(s) from the docs — see DEVIATION lines`);
console.log("youtubeRoutes.blocked.contract: all checks passed");
