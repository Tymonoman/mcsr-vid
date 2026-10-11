// Self-check for handShort.ts (config.shortsByHand, 11 Oct 2026: "you're gonna make the shorts
// from now on"): what `npm run short:hand` refuses before writing a byte, and what a clean build
// leaves on disk. ffprobe is injected (never spawned, so this stays in test:unit); the MCSR API
// is stubbed at global fetch with a real match fixture. Pins: the CLI's refusals (a bad hook, the
// wrong file shape, already on the channel, a blocked player, the match record down), and a
// clean build's mp4/title/description/hand.json — the title and description built the same way
// generateShort.ts builds them, byte for byte.
// Run: npx tsx src/shorts/handShort.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchInfo } from "../api/types.js";
import {
  buildHandShort,
  checkHandShort,
  handShortFile,
  HandShortRefusal,
  readHandShort,
  type VideoSpec,
} from "./handShort.js";
import { buildShortDescription, buildShortTitle } from "./shortHook.js";
import { readShortLog } from "./shortLog.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-handshort-"));
config.mediaDir = media;
config.youtubePlaylistUrl = "https://www.youtube.com/playlist?list=PLHG-jSA-dWDo";
config.supportUrl = "https://ko-fi.com/example";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
// Ranked (type 2): playoffContextFor's own seriesOf short-circuits before any further fetch.
const matchOf = (id: number): MatchInfo => ({ ...fixture, changes: [], id });
const down = new Set<number>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) {
    const id = Number(m[1]!);
    if (down.has(id)) return new Response("down", { status: 503, statusText: "Service Unavailable" });
    return new Response(JSON.stringify({ status: "success", data: matchOf(id) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const dir = (id: number) => path.join(media, String(id));
let nextId = 90_000_001;
const freshId = (): number => nextId++;

const GOOD: VideoSpec = { width: 1080, height: 1920, vcodec: "h264", acodec: "aac", durationSec: 24.5 };
const probeOf = (spec: VideoSpec | null) => async () => spec;

const srcMp4 = path.join(media, "source.mp4");
writeFileSync(srcMp4, "pretend-mp4-bytes");

const baseOpts = () => ({
  mp4Path: srcMp4,
  hook: "Down to the last heart",
  fromSec: 300,
  toSec: 325,
  pov: "left" as const,
});

async function refusedCheck(
  id: number,
  opts: Parameters<typeof checkHandShort>[1],
  probe = probeOf(GOOD),
): Promise<string> {
  const check = await checkHandShort(id, opts, probe);
  assert.equal(check.ok, false, `expected a refusal, got ${JSON.stringify(check)}`);
  return (check as { ok: false; problem: string }).problem;
}

/* --- Refusals: checkHandShort names the reason, buildHandShort writes nothing ------------------ */

// No working directory for the match: never guessed into existence.
{
  const id = freshId();
  assert.match(await refusedCheck(id, baseOpts()), /no working directory/);
  assert.ok(!existsSync(dir(id)));
}

// Already on the channel: a new cut would need a re-upload, which is the operator's call.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(path.join(dir(id), "youtube-short.json"), "{}");
  assert.match(await refusedCheck(id, baseOpts()), /already on the channel/);
}

// A window that doesn't make sense.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  assert.match(await refusedCheck(id, { ...baseOpts(), fromSec: 30, toSec: 10 }), /--from must be/);
  assert.match(await refusedCheck(id, { ...baseOpts(), fromSec: -1, toSec: 10 }), /--from must be/);
}

// No such source file.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  assert.match(
    await refusedCheck(id, { ...baseOpts(), mp4Path: path.join(media, "nope.mp4") }),
    /no such file/,
  );
}

// The match record could not be read (the MCSR API down): nobody's fault, says so.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  down.add(id);
  try {
    assert.match(await refusedCheck(id, baseOpts()), /match record could not be read/);
  } finally {
    down.delete(id);
  }
}

// A blocked player (config.blockedPlayers): the fixture's doogile, blocked for this one check.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  const before = config.blockedPlayers;
  config.blockedPlayers = ["doogile"];
  try {
    assert.match(await refusedCheck(id, baseOpts()), /blocked player/);
  } finally {
    config.blockedPlayers = before;
  }
}

// A bad hook: checkHandShort defers to hookProblem (which is hookLabelProblem and
// spoilsTheResult together) rather than re-implementing any of it, and refuses outright — no
// warning-and-save-anyway here, unlike the operator's own typed hook on the dashboard.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  assert.match(await refusedCheck(id, { ...baseOpts(), hook: "x".repeat(50) }), /40 characters/);
  assert.match(await refusedCheck(id, { ...baseOpts(), hook: "doogile wins it" }), /result away/);
  assert.match(await refusedCheck(id, { ...baseOpts(), hook: "ASIAN VS CARNIVORE" }), /label/);
}

// The file itself is the wrong shape: unreadable, the wrong pixel size, the wrong codecs, too long.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  assert.match(await refusedCheck(id, baseOpts(), probeOf(null)), /ffprobe could not read/);
  assert.match(
    await refusedCheck(id, baseOpts(), probeOf({ ...GOOD, width: 1920, height: 1080 })),
    /1920x1080.*1080x1920/,
  );
  assert.match(
    await refusedCheck(id, baseOpts(), probeOf({ ...GOOD, vcodec: "vp9", acodec: "opus" })),
    /vp9\+opus.*h264\+aac/,
  );
  assert.match(await refusedCheck(id, baseOpts(), probeOf({ ...GOOD, durationSec: 61 })), /61\.0s.*60s/);
  assert.ok(!existsSync(path.join(dir(id), `short-${id}.mp4`)), "no refusal here writes anything");
}

// buildHandShort throws the same reason as a HandShortRefusal, and still writes nothing.
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  await assert.rejects(
    buildHandShort(id, { ...baseOpts(), hook: "x".repeat(50) }, { probe: probeOf(GOOD) }),
    (err: unknown) => err instanceof HandShortRefusal && /40 characters/.test((err as Error).message),
  );
  assert.ok(!existsSync(path.join(dir(id), `short-${id}.mp4`)));
  assert.ok(!existsSync(handShortFile(dir(id), id)));
}
console.log("OK: the refusals — bad hook, wrong file shape, already on the channel, a blocked player");

/* --- A clean build: the pair the chain reads, text identical to generateShort.ts's own builders */
{
  const id = freshId();
  mkdirSync(dir(id), { recursive: true });
  const now = new Date("2026-10-11T12:00:00Z");
  const result = await buildHandShort(
    id,
    { ...baseOpts(), note: "a stand-in for the real cut" },
    { probe: probeOf(GOOD), now: () => now },
  );
  const expectedTitle = buildShortTitle("Down to the last heart", "edcr", "doogile");
  assert.equal(result.title, expectedTitle);
  assert.equal(result.outPath, path.join(dir(id), `short-${id}.mp4`));

  assert.equal(readFileSync(result.outPath, "utf8"), "pretend-mp4-bytes", "the source file's own bytes");
  assert.ok(!existsSync(`${result.outPath}.tmp`), "the .tmp is gone — a rename, not a leftover copy");

  assert.equal(readFileSync(path.join(dir(id), `short-${id}.title.txt`), "utf8"), `${expectedTitle}\n`);

  const expectedDescription = buildShortDescription(
    id,
    "edcr",
    "doogile",
    config.youtubePlaylistUrl,
    config.supportUrl,
    undefined,
    11,
    "match",
  );
  assert.equal(
    readFileSync(path.join(dir(id), `short-${id}.description.txt`), "utf8"),
    expectedDescription,
    "the same description builder generateShort.ts uses — the whole-match link, the tags, all of it",
  );

  assert.deepEqual(await readHandShort(dir(id), id), {
    hook: "Down to the last heart",
    builtAt: now.toISOString(),
    windowMatchSec: [300, 325],
    pov: "left",
    note: "a stand-in for the real cut",
  });

  const log = readShortLog(id);
  assert.ok(
    log.some((l) => l.step === "render" && /hand-made Short built/.test(l.text)),
    "one log line",
  );

  // The Short this match now has on disk refuses a second cut outright, even with everything
  // else right — the chain reads the mp4 + hand.json; a byte-for-byte identical re-run must not
  // silently overwrite what may already be queued to upload.
  writeFileSync(path.join(dir(id), "youtube-short.json"), "{}");
  await assert.rejects(
    buildHandShort(id, baseOpts(), { probe: probeOf(GOOD) }),
    (err: unknown) =>
      err instanceof HandShortRefusal && /already on the channel/.test((err as Error).message),
  );
}
console.log("OK: a clean build writes the mp4, title, description and hand.json the chain reads");

console.log("handShort: all checks passed");
