// src/x/xPost.ts: what goes on X and every reason nothing does. A temp media dir of fixture
// matches; the MCSR API and api.x.com are one stubbed global fetch, so nothing leaves the box.
// Players are renamed fixtures (no real runner's name in a hook or a block list).
// Run: npx tsx src/x/xPost.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { setHidden } from "../dashboard/matchShelf.js";
import {
  autoPost,
  pickXCandidate,
  planXPost,
  postMatch,
  X_MAX_CHARS,
  XRefusal,
  xTick,
  type XPlan,
} from "./xPost.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-xpost-"));
process.on("exit", () => rmSync(media, { recursive: true, force: true }));
config.mediaDir = media;
config.blockedPlayers = ["BlockedRunner"];
config.titleNames = { RunnerAlpha: "Alpha" };
for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) delete process.env[k];

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const playersOf = new Map<number, [string, string]>();
/** Matches whose MCSR API read fails (a 429), as the shared 500-per-10-minutes budget can. */
const rateLimited = new Set<number>();
const xCalls: string[] = [];
let postCount = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.x.com") {
    xCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/2/media/upload/initialize") return json({ data: { id: "55" } });
    if (url.pathname === "/2/media/upload/55/append") return json({});
    if (url.pathname === "/2/media/upload/55/finalize") return json({ data: { id: "55" } });
    if (url.pathname === "/2/tweets") return json({ data: { id: `9${++postCount}` } }, 201);
  }
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) {
    const id = Number(m[1]);
    if (rateLimited.has(id)) return json({ status: "error", data: null }, 429);
    const [left, right] = playersOf.get(id) ?? ["RunnerAlpha", "RunnerBravo"];
    const data = {
      ...fixture,
      id,
      players: fixture.players.map((p, i) => ({ ...p, nickname: i ? right : left })),
    };
    return json({ status: "success", data });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const HOUR = 3_600_000;
const NOW = Date.now();
let nextId = 92_000_001;
/** A match directory as the chain leaves it: a long-form record, a hand-cut Short and its hand file. */
function makeMatch(
  o: {
    publishAt?: string | null;
    privacyStatus?: string;
    upload?: boolean;
    hook?: string;
    hand?: boolean;
    mp4?: boolean;
    players?: [string, string];
  } = {},
): number {
  const id = nextId++;
  const dir = path.join(media, String(id));
  mkdirSync(dir, { recursive: true });
  if (o.players) playersOf.set(id, o.players);
  if (o.upload !== false)
    writeFileSync(
      path.join(dir, "youtube.json"),
      JSON.stringify({
        videoId: `vid${id}`,
        uploadedAt: new Date(NOW - 48 * HOUR).toISOString(),
        publishAt: o.publishAt === undefined ? new Date(NOW - 2 * HOUR).toISOString() : o.publishAt,
        privacyStatus: o.privacyStatus ?? "private",
        thumbnailVariant: null,
        title: "T",
      }),
    );
  if (o.mp4 !== false) writeFileSync(path.join(dir, `short-${id}.mp4`), "short-bytes");
  if (o.hand !== false)
    writeFileSync(
      path.join(dir, `short-${id}.hand.json`),
      JSON.stringify({
        hook: o.hook ?? "ONE PEARL FROM THE END",
        builtAt: "x",
        windowMatchSec: [1, 30],
        pov: "left",
      }),
    );
  return id;
}
const refusal = async (id: number, now = NOW) => {
  const plan = await planXPost(id, now);
  assert.equal(typeof plan, "string", `match ${id} is refused`);
  return plan as string;
};

/* --- the text ------------------------------------------------------------------------------------ */
const clean = makeMatch();
const plan = (await planXPost(clean, NOW)) as XPlan;
assert.deepEqual(plan, {
  matchId: clean,
  text: `ONE PEARL FROM THE END | Alpha vs RunnerBravo\nhttps://youtu.be/vid${clean}\n#mcsr #minecraft`,
  clipPath: path.join(media, String(clean), `short-${clean}.mp4`),
  videoId: `vid${clean}`,
});
console.log(
  "OK: the text is <hook> | <left> vs <right> (titleNames spelling), the watch link, #mcsr #minecraft",
);

const question = makeMatch({ hook: "CAN ANYONE TAKE DOWN THE LEADER?" });
assert.equal(typeof (await planXPost(question, NOW)), "object", "a question hook is not a spoiler");
console.log("OK: a question hook posts (the upset framing is a question)");

const publicOnUpload = makeMatch({ publishAt: null, privacyStatus: "public" });
assert.equal(typeof (await planXPost(publicOnUpload, NOW)), "object");
console.log("OK: a long-form uploaded public (no publishAt) counts as public");

/* --- refusals ------------------------------------------------------------------------------------ */
assert.match(await refusal(makeMatch({ players: ["RunnerAlpha", "blockedrunner"] })), /blocked player/);
const blockedOnDisk = makeMatch();
writeFileSync(path.join(media, String(blockedOnDisk), "chat-BlockedRunner.json"), "[]");
assert.match(await refusal(blockedOnDisk), /blocked player/);
console.log("OK: a blocked player (API pair or the match's own files) is refused");

assert.match(await refusal(makeMatch({ publishAt: new Date(NOW + 72 * HOUR).toISOString() })), /not public yet/);
assert.match(await refusal(makeMatch({ upload: false })), /not public yet/);
assert.match(await refusal(makeMatch({ publishAt: null })), /not public yet/, "private with no publish time");
console.log("OK: a long-form scheduled for later, private, or not uploaded is not public yet");

assert.match(await refusal(makeMatch({ hand: false })), /no hand-cut Short/);
assert.match(await refusal(makeMatch({ mp4: false })), /no hand-cut Short/);
console.log("OK: no hand-cut Short (hand file or mp4 missing) is refused");

// "No Short for this one" saved after (or before) `npm run short:hand`: the hand file and mp4
// stay on disk, but the operator declined the Short, so X never gets it either.
const declined = makeMatch();
writeFileSync(path.join(media, String(declined), `short-${declined}.status.json`), JSON.stringify({ noShort: true }));
assert.match(await refusal(declined), /no Short/);
console.log('OK: a match marked "No Short for this one" is refused even with a hand-cut Short on disk');

assert.match(await refusal(makeMatch({ hook: "ALPHA WINS IT" })), /gives the result away/);
assert.match(await refusal(makeMatch({ hook: "TAS vs LOVERBOY" })), /label|nickname/i);
assert.match(await refusal(makeMatch({ hook: "THE 2080 ELO SHOWDOWN" })), /seed, rank or elo/);
console.log("OK: a spoiler, a runner label and an elo hook are refused (hookProblem)");

// X counts the link as 23 whatever its length: 105+105-character names land exactly on 280.
const long = (n: number) => "R".repeat(n);
const at280 = makeMatch({ players: [long(105), `${long(104)}S`] });
const fits = (await planXPost(at280, NOW)) as XPlan;
assert.equal(typeof fits, "object", "exactly 280 counted characters posts");
assert.ok(fits.text.length > X_MAX_CHARS, "while the raw text, with the full link, is longer");
assert.match(await refusal(makeMatch({ players: [long(105), `${long(105)}S`] })), /281 characters/);
console.log("OK: the 280 budget counts the link as 23");

/* --- dry run, post, already posted --------------------------------------------------------------- */
const dry = await postMatch(clean, { dryRun: true });
assert.equal(dry.record, null);
assert.deepEqual(xCalls, [], "a dry run signs and sends nothing");
assert.ok(!existsSync(path.join(media, String(clean), "x.json")));
await assert.rejects(
  postMatch(clean),
  (e: Error) => e instanceof XRefusal && /not configured/.test(e.message),
);
console.log("OK: a dry run plans only; a real post without keys is refused before any call");

Object.assign(process.env, { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "a" });
const posted = await postMatch(clean);
assert.deepEqual(xCalls, [
  "POST /2/media/upload/initialize",
  "POST /2/media/upload/55/append",
  "POST /2/media/upload/55/finalize",
  "POST /2/tweets",
]);
const record = JSON.parse(readFileSync(path.join(media, String(clean), "x.json"), "utf8"));
assert.deepEqual(record, { postId: "91", at: record.at, text: plan.text, mediaId: "55" });
assert.ok(Math.abs(Date.parse(record.at) - Date.now()) < 60_000);
assert.deepEqual(posted.record, record);
assert.match(await refusal(clean), /already on X/);
console.log(
  "OK: a post uploads, posts, writes x.json { postId, at, text, mediaId }; then it is already on X",
);

/* --- one a day, newest first, hidden skipped ------------------------------------------------------ */
// `clean` posted today, so autoPost waits whatever else is ready: the rest of the day, then the 40h gap.
xCalls.length = 0;
assert.match(await autoPost({ now: NOW }), /already posted today/);
assert.deepEqual(xCalls, []);
// The next UTC day is not enough: the newest x.json must be xMinHoursBetweenPosts (40) old.
assert.match(await autoPost({ now: NOW + 24 * HOUR }), /last post 2[34]h ago \(match \d+\), under the 40h gap/);
assert.deepEqual(xCalls, []);
const twoDaysOn = NOW + 48 * HOUR;
const newest = makeMatch({ publishAt: new Date(NOW - HOUR).toISOString() });
const hiddenNewer = makeMatch({ publishAt: new Date(NOW - HOUR / 2).toISOString() });
setHidden(hiddenNewer, true);
assert.equal(
  (await pickXCandidate(twoDaysOn))?.matchId,
  newest,
  "the newest public, unhidden, unposted match",
);
assert.match(await autoPost({ now: twoDaysOn, dryRun: true }), new RegExp(`would post match ${newest}`));
assert.deepEqual(xCalls, [], "auto --dry-run sends nothing");
assert.match(
  await autoPost({ now: twoDaysOn }),
  new RegExp(`posted match ${newest}: https://x.com/i/status/92`),
);
assert.ok(existsSync(path.join(media, String(newest), "x.json")));
console.log(
  "OK: at most one post a UTC day and none within 40h; the newest public long-form goes first; hidden is skipped",
);

// One candidate's MCSR read failing (429) skips that candidate, not the walk: the next one is
// picked, and autoPost does not throw (which would cost xTick the whole UTC day).
const behind = makeMatch({ publishAt: new Date(NOW - HOUR / 3).toISOString() });
const flaky = makeMatch({ publishAt: new Date(NOW - HOUR / 4).toISOString() });
rateLimited.add(flaky);
assert.equal((await pickXCandidate(twoDaysOn))?.matchId, behind, "the 429 candidate is skipped");
// x.json carries the real clock, so the last post is ~48h behind twoDaysOn: past the gap. (NOW+72h
// would also make the long-form scheduled for then public, and the newest.)
assert.match(await autoPost({ now: twoDaysOn, dryRun: true }), new RegExp(`would post match ${behind}`));
rateLimited.delete(flaky);
assert.equal((await pickXCandidate(twoDaysOn))?.matchId, flaky, "once the API answers, it is the newest again");
console.log("OK: an MCSR API error on one candidate skips it; the walk goes on to the next");

/* --- the tick ------------------------------------------------------------------------------------- */
xCalls.length = 0;
config.xAutoPost = false;
await xTick();
config.xAutoPost = true;
for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) delete process.env[k];
await xTick();
assert.deepEqual(xCalls, [], "off, or on without keys: the tick does nothing");
console.log("OK: the tick is a no-op while xAutoPost is off or the keys are missing");

/* --- the CLI's contract: no keys, `auto --dry-run` exits 0 saying so ---------------------------- */
const cwd = mkdtempSync(path.join(tmpdir(), "mcsr-xcli-")); // no .env here: no keys load
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("X_")));
const run = spawnSync(
  path.join(root, "node_modules/.bin/tsx"),
  [path.join(root, "src/x/xCli.ts"), "auto", "--dry-run"],
  {
    cwd,
    env: { ...env, MCSR_CONFIG: "/nonexistent/mcsr-vid.config.json" },
    encoding: "utf8",
  },
);
assert.equal(run.status, 0, run.stderr);
assert.match(run.stdout, /not configured/);
console.log('OK: npm run x -- auto --dry-run with no keys exits 0 and prints "not configured"');
console.log("xPost: all checks passed");
