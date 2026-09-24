// Self-check for shortFlow.ts, driven through the routes the dashboard calls. A temp media dir,
// the MCSR API stubbed at global fetch with a real match (src/fixtures), the model and the render
// and the uploader replaced by stand-ins that write what the real ones write — the uploader
// through the real guard (`hookRefusal`), so the chain is held to the rules an upload is.
// What is pinned: a pick is queued when an exported match is opened, nothing renders or uploads
// before the hooks are saved, the chain's order and times, uploads-off stops after the render, a
// changed hook re-cuts, an upload locks its hook, the tick resumes and retries, and the summary.
// Run: npx tsx src/dashboard/shortFlow.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { MatchInfo } from "../api/types.js";
import type { ShortPick, ShortPlanResponse } from "../shorts/shortPlan.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-"));
config.mediaDir = media;
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";
config.reasonerCommand = ["agy"];
config.youtubePlaylistTitle = "";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const matchOf = (id: number): MatchInfo => ({ ...fixture, changes: [], id });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ status: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) return ok(matchOf(Number(m[1])));
  const u = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (u) {
    const p = fixture.players.find((x) => x.uuid === u[1])!;
    return ok({
      uuid: p.uuid,
      nickname: p.nickname,
      eloRate: 2000,
      eloRank: 5,
      country: "us",
      statistics: {},
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const flow = await import("./shortFlow.js");
const { handleShortsRoute } = await import("./shortsRoutes.js");
const { hookRefusal } = await import("../youtube/youtubeUpload.js");
const { readUpload, writeUpload } = await import("../youtube/youtubeStore.js");
const { readShortHook } = await import("../shorts/shortHook.js");
const { nextPublishSlot } = await import("../youtube/publishSlot.js");

const dir = (id: number) => path.join(media, String(id));
/** An exported match: the finished video, a confident sync, the pipeline's own title file. */
function exported(id: number): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
  );
  // After the sync, as the export always is: a newer sync.json is a stale export (exportStale).
  const final = path.join(dir(id), `final-${id}.mp4`);
  writeFileSync(final, "x");
  utimesSync(final, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  writeFileSync(path.join(dir(id), `match-${id}.title.txt`), "Chip | edcr vs doogile | MCSR Ranked 1v1\n");
}
const pickOf = (id: number, source: "agy" | "heuristic" = "agy"): ShortPick => ({
  gameMatchId: id,
  startMs: 300_000,
  endMs: 330_000,
  pov: "both",
  focus: "left",
  hookSuggestion: "Down to the last heart",
  why: "a stand-in",
  kind: "play",
  source,
  createdAt: new Date().toISOString(),
});
const writePick = (id: number, source: "agy" | "heuristic" = "agy") =>
  writeFileSync(path.join(dir(id), `short-${id}.pick.json`), JSON.stringify(pickOf(id, source)));

// The model: a pick per call, or a failure that leaves the heuristic's pick and says why.
const picks: Array<{ id: number; force: boolean }> = [];
let modelUp = true;
/** Holds the model until released, so a plan can be seen while its pick is still queued. */
let watching: Promise<void> = Promise.resolve();
flow.setPicker(async (id, { force }) => {
  await watching;
  picks.push({ id, force });
  writePick(id, modelUp ? "agy" : "heuristic");
  const errorFile = path.join(dir(id), `short-${id}.pick-error.json`);
  if (modelUp) rmSync(errorFile, { force: true });
  else
    writeFileSync(
      errorFile,
      JSON.stringify({ at: new Date().toISOString(), message: "Antigravity is not signed in — run: agy" }),
    );
});

// The render: what generateShort writes — the Short, and the cut with the hook it burned in.
const renders: Array<{ id: number; hook: string }> = [];
const render = async (id: number): Promise<string | null> => {
  const hook = await readShortHook(dir(id), id);
  if (hook === null) return "waiting for the Short's hook";
  const pick = JSON.parse(readFileSync(path.join(dir(id), `short-${id}.pick.json`), "utf8")) as ShortPick;
  writeFileSync(path.join(dir(id), `short-${id}.mp4`), "short");
  writeFileSync(path.join(dir(id), `short-${id}.title.txt`), `${hook} | edcr vs doogile #mcsr #minecraft\n`);
  writeFileSync(
    path.join(dir(id), `short-${id}.cut.json`),
    JSON.stringify({ ...pick, hook, pickCreatedAt: pick.createdAt, renderedAt: new Date().toISOString() }),
  );
  renders.push({ id, hook });
  return null;
};

// The uploader: the real guard, then a record as beginUpload writes one.
const sent: Array<{ id: number; kind: string; publishAt?: string; privacyStatus: string }> = [];
let failVideo: string | null = null;
const upload: import("./shortFlow.js").ChainDeps["upload"] = async (id, req) => {
  const refused = await hookRefusal(id, req.kind);
  if (refused) return refused;
  sent.push({ id, kind: req.kind, publishAt: req.publishAt, privacyStatus: req.privacyStatus });
  const progress = {
    matchId: id,
    kind: req.kind,
    uploaded: 1,
    total: 1,
    done: true,
    error: req.kind === "video" ? failVideo : null,
    warnings: [],
    videoId: `${req.kind}-${id}`,
  };
  if (!progress.error)
    await writeUpload(
      id,
      {
        videoId: progress.videoId,
        uploadedAt: new Date().toISOString(),
        publishAt: req.publishAt ?? null,
        privacyStatus: req.privacyStatus,
        thumbnailVariant: null,
        title: "t",
      },
      req.kind,
    );
  return { progress, finished: Promise.resolve(progress) };
};
const NOW = Date.parse("2026-09-24T08:00:00Z");
const chain = { render, upload, refreshChannel: async () => {}, now: () => NOW };

/* --- Transport stand-ins ----------------------------------------------------------------------- */
function context(body = "") {
  const calls: Array<{ status: number; payload: unknown }> = [];
  return {
    calls,
    ctx: {
      json: (_res: ServerResponse, status: number, payload: unknown) => calls.push({ status, payload }),
      readBody: async () => body,
      matchDir: dir,
      parseId: (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
    },
  };
}
const res = {} as ServerResponse;
async function call(method: string, action: string, id: number, body?: unknown) {
  const { ctx, calls } = context(body === undefined ? "" : JSON.stringify(body));
  const handled = await handleShortsRoute(
    { method } as IncomingMessage,
    res,
    ["", "shorts", action, String(id)],
    ctx,
    {
      chain,
    },
  );
  assert.ok(handled, `${method} ${action} is a route`);
  return calls[0]! as { status: number; payload: ShortPlanResponse & { error?: string } };
}
const plan = async (id: number) => (await call("GET", "plan", id)).payload;
/** Save the hooks and wait for the chain the save started. */
async function save(id: number, body: unknown) {
  const answer = await call("PUT", "hooks", id, body);
  await flow.chainIdle(id);
  return answer;
}

try {
  /* --- 1. Opening an exported match queues the model's pick ------------------------------------- */
  const A = 13_000_001;
  exported(A);
  let release = () => {};
  watching = new Promise((r) => (release = r));
  const first = await plan(A);
  assert.equal(first.pickActivity, "running", "the backlog fills in as it is opened");
  assert.equal(first.state, "picking");
  assert.equal(first.pick, null);
  release();
  await flow.picksIdle();
  const opened = await plan(A);
  assert.deepEqual(picks, [{ id: A, force: false }], "one pick, not forced");
  assert.equal(opened.state, "waiting-for-hook");
  assert.equal(opened.detail, "Short 5:00–5:30, 30 s, both");
  assert.equal(opened.suggestions.short[0], "Down to the last heart", "the model's hook comes first");
  assert.ok(opened.suggestions.title.length > 0, "the title chips");
  assert.deepEqual(opened.preview, { videoUrl: `/api/export/preview/${A}`, startSec: 310, endSec: 340 });
  assert.equal(opened.syncWeak, undefined, "a confident sync is not weak");
  assert.deepEqual(opened.uploads, {});
  assert.deepEqual(opened.errors, []);
  assert.deepEqual(await flow.matchRowShort(A), {
    shortState: "waiting-for-hook",
    shortDetail: "Short 5:00–5:30, 30 s, both",
  });
  // Opening it again does not ask the model twice.
  await plan(A);
  await flow.picksIdle();
  assert.equal(picks.length, 1);

  /* --- 2. The gate: nothing renders or uploads before the hooks are saved ---------------------- */
  await flow.startChain(A, chain);
  assert.equal(renders.length, 0, "no hooks, no render");
  assert.equal(sent.length, 0, "no hooks, no upload");
  assert.deepEqual(await hookRefusal(A, "video"), {
    status: 409,
    error: "no saved title hook — save the hooks first",
  });

  // The CLI itself refuses, before it reads anything else.
  {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const cwd = mkdtempSync(path.join(tmpdir(), "mcsr-shortcli-"));
    writeFileSync(path.join(cwd, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }));
    const cli = spawnSync(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "shorts", "generateShort.ts"), String(A)],
      { cwd, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /waiting for the Short's hook/);
    assert.ok(!existsSync(path.join(dir(A), `short-${A}.mp4`)));
    console.log("OK: npm run short refuses without the hook");
  }

  /* --- 3. Saving the hooks: what is refused -------------------------------------------------------- */
  assert.equal((await call("PUT", "hooks", A, { shortHook: "x" })).status, 400, "no title hook");
  assert.equal(
    (await call("PUT", "hooks", A, { titleHook: "Hook", shortHook: null })).status,
    400,
    "no Short hook",
  );
  assert.equal((await call("PUT", "hooks", A, { titleHook: "a <b>", shortHook: "x" })).status, 400, "< >");
  const tooLong = await call("PUT", "hooks", A, { titleHook: "x".repeat(60), shortHook: "x" });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.payload.error!, /this title has room for \d+/);
  const longShort = await call("PUT", "hooks", A, { titleHook: "Hook", shortHook: "y".repeat(90) });
  assert.equal(longShort.status, 400, "a Short title over 100");
  assert.equal(renders.length, 0, "a refused save starts nothing");

  /* --- 4. Saved: render, then the long-form, then the Short, at their times ---------------------- */
  const saved = await save(A, { titleHook: "One heart left", shortHook: "Down to the last heart" });
  assert.equal(saved.status, 202);
  assert.equal(
    readFileSync(path.join(dir(A), `match-${A}.title.edited.txt`), "utf8"),
    "One heart left | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun\n",
    "the title hook, in the pipeline's own title",
  );
  assert.equal(readFileSync(path.join(dir(A), `short-${A}.hook.txt`), "utf8"), "Down to the last heart\n");
  assert.deepEqual(renders, [{ id: A, hook: "Down to the last heart" }]);
  const slot = nextPublishSlot(NOW, config.publishHourUtc, []).toISOString();
  assert.equal(slot, "2026-09-24T19:00:00.000Z");
  assert.deepEqual(sent, [
    { id: A, kind: "video", publishAt: slot, privacyStatus: "private" },
    { id: A, kind: "short", publishAt: "2026-09-25T13:00:00.000Z", privacyStatus: "private" },
  ]);
  const done = await plan(A);
  assert.equal(done.state, "scheduled");
  assert.deepEqual(done.uploads, {
    video: { videoId: `video-${A}`, publishAt: slot },
    short: { videoId: `short-${A}`, publishAt: "2026-09-25T13:00:00.000Z" },
  });
  assert.equal(done.titleHook, "One heart left");
  assert.equal(done.shortHook, "Down to the last heart");
  console.log("OK: saved hooks run render → long-form → Short, the Short 18 h after the long-form");

  /* --- 5. An upload locks its hook ---------------------------------------------------------------- */
  const moved = await call("PUT", "hooks", A, {
    titleHook: "Another line",
    shortHook: "Down to the last heart",
  });
  assert.equal(moved.status, 409);
  assert.match(moved.payload.error!, /re-upload/);
  const movedShort = await call("PUT", "hooks", A, {
    titleHook: "One heart left",
    shortHook: "Another line",
  });
  assert.equal(movedShort.status, 409);
  const same = await save(A, { titleHook: "One heart left", shortHook: "Down to the last heart" });
  assert.equal(same.status, 202, "the same hooks again are fine");
  assert.equal(sent.length, 2, "and upload nothing twice");
  assert.equal((await call("POST", "pick", A)).status, 409, "no new pick under a Short on the channel");

  /* --- 6. Uploads off: the render, then a state that says Publish is the way --------------------- */
  const B = 13_000_002;
  exported(B);
  writePick(B);
  config.nightlyUpload = "off";
  await save(B, { titleHook: "One heart left", shortHook: "First line" });
  assert.deepEqual(renders.at(-1), { id: B, hook: "First line" });
  assert.equal(sent.length, 2, "nothing uploaded");
  const off = await plan(B);
  assert.equal(off.state, "failed");
  assert.match(off.detail!, /uploads are off/);
  // A hook changed after the render, before any upload: the Short is cut again behind it.
  await save(B, { titleHook: "One heart left", shortHook: "Second line" });
  assert.deepEqual(
    renders.filter((r) => r.id === B).map((r) => r.hook),
    ["First line", "Second line"],
  );
  // Switched on, saved again: no third render, and both go up — the long-form a day after A's slot.
  config.nightlyUpload = "scheduled";
  await save(B, { titleHook: "One heart left", shortHook: "Second line" });
  assert.equal(renders.filter((r) => r.id === B).length, 2, "the Short on disk is current");
  assert.deepEqual(
    sent.filter((s) => s.id === B).map((s) => [s.kind, s.publishAt]),
    [
      ["video", "2026-09-25T19:00:00.000Z"],
      ["short", "2026-09-26T13:00:00.000Z"],
    ],
    "one slot a day: A has the 24th",
  );
  console.log("OK: uploads off stops after the render; a new hook re-cuts; switched on, both go up");

  /* --- 7. "private": no publish time on either ----------------------------------------------------- */
  const C = 13_000_003;
  exported(C);
  writePick(C);
  config.nightlyUpload = "private";
  await save(C, { titleHook: "One heart left", shortHook: "Private line" });
  assert.deepEqual(
    sent.filter((s) => s.id === C).map((s) => [s.kind, s.publishAt]),
    [
      ["video", undefined],
      ["short", undefined],
    ],
  );
  assert.equal((await plan(C)).state, "scheduled");
  assert.match((await plan(C)).detail!, /private with no publish time/);
  config.nightlyUpload = "scheduled";

  /* --- 8. No Short for this one: the long-form goes alone ----------------------------------------- */
  const D = 13_000_004;
  exported(D);
  const alone = await save(D, { titleHook: "One heart left", shortHook: null, noShort: true });
  assert.equal(alone.status, 202);
  assert.equal(alone.payload.noShort, true);
  assert.deepEqual(
    sent.filter((s) => s.id === D).map((s) => s.kind),
    ["video"],
  );
  assert.equal(renders.filter((r) => r.id === D).length, 0);
  assert.ok(!existsSync(path.join(dir(D), `short-${D}.hook.txt`)));
  assert.equal((await plan(D)).state, "scheduled");

  /* --- 9. A failed upload is a failed step with its error, and a save is the retry --------------- */
  const E = 13_000_005;
  exported(E);
  writePick(E);
  failVideo = "network went away";
  await save(E, { titleHook: "One heart left", shortHook: "Retry line" });
  const failed = await plan(E);
  assert.equal(failed.state, "failed");
  assert.deepEqual(
    failed.errors.map((e) => [e.step, e.message]),
    [["upload-video", "network went away"]],
  );
  assert.ok(!sent.some((s) => s.id === E && s.kind === "short"), "no Short without its long-form");
  failVideo = null;
  await save(E, { titleHook: "One heart left", shortHook: "Retry line" });
  assert.equal((await plan(E)).state, "scheduled");
  assert.deepEqual((await plan(E)).errors, [], "the retry's run carries no old error");

  /* --- 10. Short times ------------------------------------------------------------------------------ */
  const at = (iso: string) => ({ videoId: "v", publishAt: iso, privacyStatus: "private" });
  assert.equal(
    flow.shortPublishAt(at("2026-09-24T19:00:00Z"), NOW)?.toISOString(),
    "2026-09-25T13:00:00.000Z",
  );
  assert.equal(
    flow.shortPublishAt(at("2026-09-20T19:00:00Z"), NOW)?.toISOString(),
    "2026-09-24T09:00:00.000Z",
    "an hour from now when 18 h after the long-form has passed",
  );
  assert.equal(
    flow.shortPublishAt({ videoId: "v", publishAt: null, privacyStatus: "public" }, NOW)?.toISOString(),
    "2026-09-24T09:00:00.000Z",
  );
  assert.equal(flow.shortPublishAt({ videoId: "v", publishAt: null, privacyStatus: "private" }, NOW), null);

  /* --- 11. The tick: resume a chain a restart cut short; retry a heuristic pick once a day -------- */
  const F = 13_000_006;
  exported(F);
  writePick(F);
  writeFileSync(path.join(dir(F), `match-${F}.title.edited.txt`), "One heart left | edcr vs doogile\n");
  writeFileSync(path.join(dir(F), `short-${F}.hook.txt`), "Resumed line\n");
  writeFileSync(
    path.join(dir(F), `short-${F}.status.json`),
    JSON.stringify({
      hooksSavedAt: "2026-09-24T07:00:00Z",
      steps: { render: { state: "running", at: "2026-09-24T07:01:00Z" } },
      errors: [],
    }),
  );
  const G = 13_000_007;
  const H = 13_000_008;
  // Newer than every model pick above, which carry the wall clock (pickOf). A fixed date here
  // went stale at 03:00 UTC on 24 Sept 2026 and the picker read healthy from then on.
  const failedAt = new Date(Date.now() + 60_000).toISOString();
  for (const id of [G, H]) {
    exported(id);
    writePick(id, "heuristic");
    writeFileSync(
      path.join(dir(id), `short-${id}.pick-error.json`),
      JSON.stringify({ at: failedAt, message: "Antigravity is not signed in — run: agy" }),
    );
  }
  // The picker's health reads the newest failure: not signed in, and nothing since.
  const summary = await flow.nightlyShortSummary();
  assert.deepEqual(summary.picker, { ok: false, message: "Antigravity is not signed in — run: agy" });
  assert.ok(summary.waitingForHook.includes(G) && summary.waitingForHook.includes(H));
  assert.ok(!summary.waitingForHook.includes(A), "a match on the channel waits for nothing");

  modelUp = false;
  picks.length = 0;
  await flow.shortTick(chain, NOW);
  await flow.chainIdle(F);
  assert.deepEqual(renders.at(-1), { id: F, hook: "Resumed line" }, "the interrupted chain ran again");
  assert.ok(
    sent.some((s) => s.id === F && s.kind === "short"),
    "to the end",
  );
  assert.equal(picks.length, 1, "the model still down: the first retry fails and the tick's retries end");
  assert.equal(picks[0]!.force, true);
  await flow.shortTick(chain, NOW);
  assert.equal(picks.length, 2, "the next tick tries the other one");
  await flow.shortTick(chain, NOW);
  assert.equal(picks.length, 2, "and then none: at most once a day per match");
  modelUp = true;
  await flow.shortTick(chain, NOW + 24 * 3600_000);
  assert.equal(picks.length, 4, "the next night: the model answers, so both are retried in one tick");
  assert.ok(!existsSync(path.join(dir(G), `short-${G}.pick-error.json`)));
  assert.deepEqual((await flow.nightlyShortSummary()).picker, { ok: true });
  console.log("OK: the tick resumes an interrupted chain and retries heuristic picks once a day");

  /* --- 12. Weak sync, and a series' preview offset ------------------------------------------------ */
  writeFileSync(
    path.join(dir(G), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 0, detail: "", source: "coarse" }),
  );
  assert.equal((await plan(G)).syncWeak, true);
  const S = 13_000_009;
  const S2 = 13_000_010;
  mkdirSync(dir(S), { recursive: true });
  mkdirSync(dir(S2), { recursive: true });
  writeFileSync(path.join(dir(S), `series-${S}.mp4`), "x");
  for (const id of [S, S2])
    writeFileSync(
      path.join(dir(id), "sync.json"),
      JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
    );
  writeFileSync(
    path.join(dir(S), "series.json"),
    JSON.stringify({
      season: 11,
      slotId: 9,
      round: "Round of 16",
      bestOf: 5,
      firstTo: 3,
      seeds: [],
      games: [
        { matchId: S, gameNo: 1, winnerUuid: null, durationSec: 600 },
        { matchId: S2, gameNo: 2, winnerUuid: null, durationSec: 500 },
      ],
      assembledAt: "t",
    }),
  );
  writeFileSync(path.join(dir(S), `short-${S}.pick.json`), JSON.stringify({ ...pickOf(S), gameMatchId: S2 }));
  const series = await plan(S);
  assert.deepEqual(series.preview, { videoUrl: `/api/export/preview/${S}`, startSec: 910, endSec: 940 });
  assert.equal(series.detail, "Short game 2 5:00–5:30, 30 s, both");
  console.log("OK: plan, hooks, pick and the chain");
} finally {
  rmSync(media, { recursive: true, force: true });
}

console.log("shortFlow: all checks passed");
