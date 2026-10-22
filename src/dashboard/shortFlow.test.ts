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

// The CLI runs in a temp cwd with its own config file: test:unit's MCSR_CONFIG (a missing file, so
// unit tests run on DEFAULTS) must not follow it into the child, or the child ignores that file.
const { MCSR_CONFIG: _ignoredConfig, ...cliEnv } = process.env;

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-"));
config.mediaDir = media;
// A Studio upload's record step backs the match up (archiveMatch): here, never the NAS's /archive.
const archive = path.join(media, "archive");
process.env.MCSR_ARCHIVE_DIR = archive;
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";
config.reasonerCommand = ["agy"];
config.youtubePlaylistTitle = "";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
/** Ids the API serves as private-room matches (type 3), as every playoff game is. */
const privateRooms = new Set<number>();
/** Ids served without the loser's dragon: no finish margin, so no "Decided by 1 second" chip. */
const noFinishMargin = new Set<number>();
const matchOf = (id: number): MatchInfo => ({
  ...fixture,
  changes: [],
  id,
  ...(privateRooms.has(id) ? { type: 3 } : {}),
  ...(noFinishMargin.has(id)
    ? {
        timelines: fixture.timelines.filter((t) => t.uuid === fixture.result.uuid || !/dragon/.test(t.type)),
      }
    : {}),
});
/** The MCSR API's answer while it is down. */
let mcsrDown = false;
/** Runs (once) inside the next `/users/<uuid>` request, before it answers — something the operator
 *  does while a tick is still waiting on the API. */
let duringUserFetch: (() => Promise<void>) | null = null;
/** YouTube, stubbed: the token and videos.list / videos.update, every call recorded. Nothing reaches Google. */
const ytVideos = new Map<string, { channelId: string; status: Record<string, unknown> }>();
const ytCalls: Array<{ method: string; url: string; body?: unknown }> = [];
/** Holds the next videos.list / videos.update call until it resolves — a Move caught mid-API-call. */
let ytHold: Promise<void> | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com")
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
  if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
    const hold = ytHold;
    ytHold = null;
    await hold;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { id: string; status: Record<string, unknown> })
      : undefined;
    ytCalls.push({ method, url: String(url), ...(body ? { body } : {}) });
    if (body) {
      const v = ytVideos.get(body.id)!;
      v.status = { ...v.status, ...body.status };
      return new Response(JSON.stringify({ id: body.id, status: v.status }));
    }
    const id = url.searchParams.get("id")!;
    const v = ytVideos.get(id);
    return new Response(
      JSON.stringify({ items: v ? [{ id, snippet: { channelId: v.channelId }, status: v.status }] : [] }),
    );
  }
  if (mcsrDown) return new Response("upstream down", { status: 503, statusText: "Service Unavailable" });
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ status: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) return ok(matchOf(Number(m[1])));
  const u = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (u) {
    const during = duringUserFetch;
    duringUserFetch = null;
    await during?.();
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
const { setHidden } = await import("./matchShelf.js");
const { handleShortsRoute } = await import("./shortsRoutes.js");
const { finishOnYouTube, hookRefusal, recordStudioUpload, thumbnailRefusal } =
  await import("../youtube/youtubeUpload.js");
const { startRerender, thumbJob } = await import("../thumbnails/rerender.js");
const { readUpload, writeUpload, uploadTextFor } = await import("../youtube/youtubeStore.js");
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
const standIn: import("./shortFlow.js").Picker = async (id, { force }) => {
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
};
flow.setPicker(standIn);

// The render: what generateShort writes — the Short, and the cut with the hook it burned in.
const renders: Array<{ id: number; hook: string }> = [];
/** Holds a render after it has read its hook, so a save can land mid-render. */
let renderGate: Promise<void> = Promise.resolve();
const render = async (id: number): Promise<string | null> => {
  const hook = await readShortHook(dir(id), id);
  if (hook === null) return "waiting for the Short's hook";
  await renderGate;
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
/** Every match id `upload` has been called for, pushed before the gate: lets a test wait until
 * two concurrent chains have both *finished picking their slot and called upload*, not just
 * entered the upload-video step (which `chainStep` marks before either has). */
const uploadCalls: number[] = [];
let failVideo: string | null = null;
/** Holds an upload once it has begun, so a press can land while it is being sent. */
let uploadGate: Promise<void> = Promise.resolve();
const upload: import("./shortFlow.js").ChainDeps["upload"] = async (id, req) => {
  uploadCalls.push(id);
  await uploadGate;
  const refused = (await hookRefusal(id, req.kind)) ?? thumbnailRefusal(id, req.kind);
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
let listed = 0;
const chain = {
  render,
  upload,
  refreshChannel: async () => {
    listed++;
  },
  now: () => NOW,
};

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
  // The pick's own titleHooks no longer feed the dashboard's title chips (18 Oct 2026): a title
  // hook is titleOptions.ts's job now (shown on Telegram, chosen by `chooseAutoHooks`), not the
  // Short-moment model's — pinned in shortFlow.contract.test.ts's "A" scenarios instead.
  {
    const file = path.join(dir(A), `short-${A}.pick.json`);
    const kept = readFileSync(file, "utf8");
    writeFileSync(
      file,
      JSON.stringify({
        ...pickOf(A),
        titleHooks: ["DEAD HEAT AT THE DRAGON", "ICE COLD"],
        createdAt: "2026-09-24T08:00:00Z",
      }),
    );
    const titled = (await plan(A)).suggestions.title;
    assert.ok(
      !titled.includes("DEAD HEAT AT THE DRAGON"),
      `the pick's titleHooks must not surface: ${titled}`,
    );
    writeFileSync(file, kept);
  }

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
      { cwd, env: cliEnv, encoding: "utf8", timeout: 60_000 },
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
  assert.equal(renders.length, 0, "a refused save starts nothing");

  // What becomes a warning rather than refusal:
  const W = 13_000_030;
  mkdirSync(dir(W), { recursive: true });

  const withAngle = await call("PUT", "hooks", W, { titleHook: "a <b>", shortHook: "x" });
  assert.equal(withAngle.status, 202);
  assert.ok(withAngle.payload.saveWarnings?.some((w) => /< > were removed/.test(w)));

  const newlineSave = await call("PUT", "hooks", W, {
    titleHook: "Line 1\nLine 2",
    shortHook: "Short\nhook",
  });
  assert.equal(newlineSave.status, 202);
  assert.ok(newlineSave.payload.saveWarnings?.some((w) => /newlines/i.test(w)));
  assert.equal(
    readFileSync(path.join(dir(W), `match-${W}.title.edited.txt`), "utf8").split("\n")[0],
    "Line 1 Line 2 | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
  );
  assert.equal(readFileSync(path.join(dir(W), `short-${W}.hook.txt`), "utf8"), "Short hook\n");

  const tooLong = await call("PUT", "hooks", W, { titleHook: "x".repeat(60), shortHook: "x" });
  assert.equal(tooLong.status, 202);
  assert.ok(tooLong.payload.saveWarnings?.some((w) => /this title has room for \d+/.test(w)));

  const longShort = await call("PUT", "hooks", W, { titleHook: "Hook", shortHook: "y".repeat(90) });
  assert.equal(longShort.status, 202, "a Short title over 100");
  assert.ok(longShort.payload.saveWarnings?.some((w) => /YouTube refuses over 100/.test(w)));

  // A typed hook is held to the chips' rule: nothing names the winner, and a sweep is a result.
  for (const body of [
    { titleHook: "PLAYOFFS | SWEPT vs TAS", shortHook: "Down to the last heart" },
    { titleHook: "One heart left", shortHook: "WINNER vs 3rd PLACE" },
  ]) {
    const spoiled = await call("PUT", "hooks", W, body);
    assert.equal(spoiled.status, 202, JSON.stringify(body));
    assert.ok(spoiled.payload.saveWarnings?.some((w) => /give the result away/i.test(w)));
  }

  // A nickname the channel already uses for another player is a warning beside the field, never a
  // refusal (30 Sept 2026 post-mortem): LOVERBOY is Infume's on two uploads, this match is edcr
  // vs doogile; CARNIVORE sat beside doogile once, so it may be his.
  {
    const earlier = [
      [13_200_001, "LOVERBOY vs TAS | Infume vs BeefSalad"],
      [13_200_002, "LOVERBOY vs UNC | Infume vs Feinberg"],
      [13_200_003, "CARNIVORE vs VEGAN | doogile vs silverrruns"],
    ] as const;
    for (const [id, title] of earlier) {
      mkdirSync(dir(id), { recursive: true });
      await writeUpload(id, {
        videoId: `video-${id}`,
        uploadedAt: "2026-09-12T19:00:00Z",
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: `${title} | MCSR Ranked 1v1 | Minecraft Speedrun`,
      });
    }
    // Also: a nickname-pair hook is now a warning too, whatever it names (2 Oct 2026) — "LOVERBOY
    // vs LOCKED IN" names neither edcr nor doogile, so it is flagged on that count as well as (or
    // instead of) any reuse; the reuse and label checks are independent and both land in the array.
    const reused = await call("PUT", "hooks", W, { titleHook: "LOVERBOY vs LOCKED IN", shortHook: "x" });
    assert.equal(reused.status, 202, "saved anyway");
    assert.deepEqual(reused.payload.saveWarnings, [
      '"LOVERBOY vs LOCKED IN" names a runner with a label: runners have objected to this (2 Oct 2026) — saved anyway',
      '"LOVERBOY" stood for Infume on 2026-09-12 — one nickname per player',
    ]);
    assert.equal(
      readFileSync(path.join(dir(W), `match-${W}.title.edited.txt`), "utf8").split("\n")[0],
      "LOVERBOY vs LOCKED IN | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
    );
    // "ASIAN" is also a denied word on its own (2 Oct 2026: "ASIAN VS CARNIVORE" was a live
    // title) — CARNIVORE's own reuse is still quiet (its one past pairing, doogile, is in this
    // match), so the label warning below is the *only* one, not a second reuse warning for it.
    const own = await call("PUT", "hooks", W, { titleHook: "CARNIVORE vs ASIAN", shortHook: "x" });
    assert.equal(own.status, 202);
    assert.deepEqual(own.payload.saveWarnings, [
      '"CARNIVORE vs ASIAN" names a runner with a label: runners have objected to this (2 Oct 2026) — saved anyway',
    ]);
    // Their records would count as uploads in the chain's slot rules below.
    for (const [id] of earlier) rmSync(dir(id), { recursive: true, force: true });
  }
  await flow.chainIdle(W);

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
  // The panel's Upload pressed after the chain uploaded (24 Sept: one long-form went up twice).
  assert.deepEqual(await hookRefusal(A, "video"), {
    status: 409,
    error: `the long-form of match ${A} is already on the channel`,
  });
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

  // A re-render of the thumbnails in flight: the long-form's upload is refused, which the step shows
  // as failed with the refusal (Retry beside it on the Now panel), and the save is the retry.
  {
    const T = 13_000_011;
    exported(T);
    writePick(T);
    let drawn!: () => void;
    startRerender(T, (() => new Promise((r) => (drawn = () => r({} as never)))) as never);
    await save(T, { titleHook: "One heart left", shortHook: "Retry line" });
    const held = await plan(T);
    assert.equal(held.state, "failed");
    assert.equal(held.errors[0]?.step, "upload-video");
    assert.match(held.errors[0]!.message, /thumbnails of match \d+ are being re-rendered or put in place/);
    drawn();
    await thumbJob(T)!.finished;
    await save(T, { titleHook: "One heart left", shortHook: "Retry line" });
    assert.equal((await plan(T)).state, "scheduled");
  }

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
  // A teaser day (x6): the Short goes public BEFORE the long-form, still no sooner than an hour out.
  {
    const { writeExperiments } = await import("./experiments.js");
    const teaser = { experimentId: "x6", arm: "before", slot: { shortDelayHours: -2 } };
    writeExperiments({
      experiments: [],
      schedule: [
        { date: "2026-09-26", ...teaser },
        { date: "2026-09-24", ...teaser },
      ],
    });
    assert.equal(
      flow.shortPublishAt(at("2026-09-26T19:00:00Z"), NOW)?.toISOString(),
      "2026-09-26T17:00:00.000Z",
      "two hours before its long-form",
    );
    assert.equal(
      flow.shortPublishAt(at("2026-09-24T10:00:00Z"), NOW)?.toISOString(),
      "2026-09-24T09:00:00.000Z",
      "an hour from now when the teaser's time is under an hour away",
    );
    rmSync(path.join(media, ".experiments.json"));
    assert.equal(
      flow.shortPublishAt(at("2026-09-26T19:00:00Z"), NOW)?.toISOString(),
      "2026-09-27T13:00:00.000Z",
      "no entry: the standing 18 h",
    );
  }

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
  for (const id of [G, H]) {
    exported(id);
    writePick(id, "heuristic");
    writeFileSync(
      path.join(dir(id), `short-${id}.pick-error.json`),
      // After every pick written so far, which carry the real clock (a fixed "2026-09-24T03:00Z"
      // stopped being "since" once the calendar passed it).
      JSON.stringify({
        at: new Date(Date.now() + 60_000).toISOString(),
        message: "Antigravity is not signed in — run: agy",
      }),
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

  /* --- 11a-bis. A corrupt state file must not starve every match ordered after it --------------- */
  {
    const BROKEN = 13_000_091;
    const AFTER = 13_000_092;
    exported(BROKEN);
    writePick(BROKEN, "heuristic");
    // A truncated pick-error.json (a kill mid-write): readJson now reads this defensively (the
    // same fix as readHandShort's own finding) and returns null rather than throwing, so this
    // match is simply "no recorded error" — not crashed, not stuck. shortTick's per-match
    // try/catch is the second line of defence, for anything else this loop might ever throw on.
    writeFileSync(path.join(dir(BROKEN), `short-${BROKEN}.pick-error.json`), "{not valid json");
    exported(AFTER);
    writePick(AFTER, "heuristic");
    writeFileSync(
      path.join(dir(AFTER), `short-${AFTER}.pick-error.json`),
      JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString(), message: "stand-in failure" }),
    );
    modelUp = true;
    picks.length = 0;
    await flow.shortTick(chain, NOW + 48 * 3600_000);
    assert.ok(
      picks.some((p) => p.id === BROKEN),
      "the corrupt-file match is retried rather than left stuck",
    );
    assert.ok(
      picks.some((p) => p.id === AFTER),
      "the match after it was still retried in the same tick",
    );
    console.log("OK: a corrupt pick-error.json no longer crashes the tick, for either match");
  }

  /* --- 11b. A restart cut short an UPLOAD step: resumed through its own session, never re-sent -- */
  // The real resumeUpload is unit-tested in youtube(Upload).test.ts; this pins the wiring —
  // `advance` must settle a "running" upload step through `deps.resumeUpload`, not the record a
  // premature channel-scan pairing could have written, and never fall back to `deps.upload`.
  {
    const RESUME = 13_000_900;
    exported(RESUME);
    writePick(RESUME);
    writeFileSync(path.join(dir(RESUME), `match-${RESUME}.title.edited.txt`), "Resumed | edcr vs doogile\n");
    writeFileSync(
      path.join(dir(RESUME), `short-${RESUME}.status.json`),
      JSON.stringify({
        hooksSavedAt: "2026-09-24T07:00:00Z",
        noShort: true,
        steps: { "upload-video": { state: "running", at: "2026-09-24T07:01:00Z" } },
        errors: [],
      }),
    );
    const resumeCalls: Array<{ id: number; kind: string }> = [];
    const resumedOk = {
      ...chain,
      resumeUpload: async (id: number, kind: "video" | "short") => {
        resumeCalls.push({ id, kind });
        // What the real resumeUpload does on success: its own record, so the main loop sees the
        // upload as done rather than looping back into a fresh `deps.upload`.
        await writeUpload(
          id,
          {
            videoId: `resumed-${kind}-${id}`,
            uploadedAt: new Date().toISOString(),
            publishAt: null,
            privacyStatus: "private",
            thumbnailVariant: null,
            title: "t",
            source: "dashboard",
          },
          kind,
        );
        return null;
      },
    };
    const sentBefore = sent.length;
    await flow.shortTick(resumedOk, NOW);
    await flow.chainIdle(RESUME);
    assert.deepEqual(resumeCalls, [{ id: RESUME, kind: "video" }], "resumed once, through its own session");
    assert.equal(sent.length, sentBefore, "the normal upload step never ran for it");
    assert.equal((await readUpload(RESUME, "video"))?.videoId, `resumed-video-${RESUME}`);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir(RESUME), `short-${RESUME}.status.json`), "utf8")).steps[
        "upload-video"
      ].state,
      "done",
      "the step settles instead of staying running forever",
    );

    // A resume that cannot settle it (no session left, nothing trustworthy on record) fails the
    // step with the server's own message, so the tick does not spin on it either.
    writeFileSync(
      path.join(dir(RESUME), `short-${RESUME}.status.json`),
      JSON.stringify({
        hooksSavedAt: "2026-09-24T07:00:00Z",
        noShort: true,
        steps: { "upload-video": { state: "running", at: "2026-09-24T07:01:00Z" } },
        errors: [],
      }),
    );
    const resumedFailing = { ...chain, resumeUpload: async () => "check Studio, then Retry" };
    await flow.shortTick(resumedFailing, NOW);
    await flow.chainIdle(RESUME);
    const afterFail = JSON.parse(readFileSync(path.join(dir(RESUME), `short-${RESUME}.status.json`), "utf8"));
    assert.equal(afterFail.steps["upload-video"].state, "failed");
    assert.equal(afterFail.steps["upload-video"].detail, "check Studio, then Retry");
    console.log("OK: a cut-short upload step resumes through its own session and always settles");
  }

  // A mid-file failure (a 5xx on a chunk) keeps the session, and by the operator's Save — the
  // retry — the channel scan has paired the half-sent video by its description link. That studio
  // record must not read as "up": the Save resumes the session, it never skips the upload.
  {
    const HALF = 13_000_901;
    exported(HALF);
    writeFileSync(path.join(dir(HALF), `match-${HALF}.title.edited.txt`), "Half | edcr vs doogile\n");
    const sessionFile = path.join(dir(HALF), `.upload-session-final-${HALF}.mp4.json`);
    /** A session for the exported bytes (`final-<id>.mp4` is one byte), or for `total` others. */
    const saved = (session: boolean, total = 1) => {
      rmSync(path.join(dir(HALF), "youtube.json"), { force: true });
      const final = path.join(dir(HALF), `final-${HALF}.mp4`);
      if (session)
        writeFileSync(sessionFile, JSON.stringify({ filePath: final, total, sessionUrl: "https://s" }));
      else rmSync(sessionFile, { force: true });
      // What a Save leaves: the failed step cleared, the channel to be listed first.
      writeFileSync(
        path.join(dir(HALF), `short-${HALF}.status.json`),
        JSON.stringify({
          hooksSavedAt: "2026-09-24T07:00:00Z",
          noShort: true,
          recheckChannel: true,
          steps: {},
          errors: [],
        }),
      );
    };
    const resumeCalls: string[] = [];
    const scanPairs = {
      ...chain,
      refreshChannel: () =>
        writeUpload(HALF, {
          videoId: "half-sent",
          uploadedAt: new Date().toISOString(),
          publishAt: null,
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
          source: "studio",
        }),
      resumeUpload: async (_id: number, kind: "video" | "short") => (resumeCalls.push(kind), null),
    };
    saved(true);
    const sentBefore = sent.length;
    await flow.startChain(HALF, scanPairs);
    assert.deepEqual(resumeCalls, ["video"], "the half-sent long-form is resumed through its session");
    assert.equal(sent.length, sentBefore, "and never sent again from the start");
    assert.equal(
      JSON.parse(readFileSync(path.join(dir(HALF), `short-${HALF}.status.json`), "utf8")).steps[
        "upload-video"
      ].state,
      "done",
    );
    // A real Studio upload has no session file: never resumed, the scan's record stands.
    resumeCalls.length = 0;
    saved(false);
    await flow.startChain(HALF, scanPairs);
    assert.deepEqual(resumeCalls, [], "no session, no resume");

    // A dead session — the MP4 re-encoded since (as exportStale asks after a sync fix), or past
    // YouTube's day — is not resumed: a resume could only refuse, on every Save, for good. The
    // normal upload starts fresh over it.
    const resumeOnly = { ...chain, resumeUpload: scanPairs.resumeUpload };
    for (const dead of ["re-encoded", "a day old"]) {
      saved(true, dead === "re-encoded" ? 2 : 1);
      if (dead === "a day old") {
        const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(sessionFile, dayAgo, dayAgo);
      }
      const sentBeforeDead: number = sent.length;
      await flow.startChain(HALF, resumeOnly);
      assert.deepEqual(resumeCalls, [], `${dead}: never resumed`);
      assert.equal(
        sent.length,
        sentBeforeDead + 1,
        `${dead}: the long-form goes up through the normal upload`,
      );
    }
    rmSync(sessionFile, { force: true });
    console.log(
      "OK: a Save after a mid-file failure resumes the session rather than trusting the scan's pairing",
    );
  }

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

  /* --- 13. The log the plan carries: the chain's own lines, newest last ------------------------- */
  {
    const logs = new Map<number, string[]>();
    for (const id of [A, B, F])
      logs.set(
        id,
        (await plan(id)).log.map((l) => `${l.step}/${l.level}: ${l.text}`),
      );
    const texts = (id: number) => logs.get(id)!;
    assert.ok(
      texts(A).includes('chain/info: hooks saved — title: "One heart left", Short: "Down to the last heart"'),
    );
    assert.ok(texts(A).includes("chain/info: done — both videos are on the channel"));
    assert.ok(
      texts(A).some((t) => t.startsWith("chain/warn: save refused: the long-form is already on the channel")),
      "a lock refusal is logged",
    );
    assert.ok(texts(B).some((t) => t.startsWith("chain/warn: uploads are off")));
    assert.ok(
      texts(B).includes(
        'chain/info: the Short hook changed since the cut — cutting it again behind "Second line"',
      ),
    );
    assert.ok(texts(F).includes("chain/warn: resumed after a restart — the render step was cut short"));
    assert.ok(texts(A).length <= 60 && (await plan(A)).activity === undefined, "nothing runs for A now");
    // E's upload failed, and the save that retried it listed the channel first: a failed upload
    // may have reached YouTube before the connection went.
    assert.ok(listed >= 1, "the retry of a failed upload lists the channel before sending again");
    console.log("OK: the plan carries the log — saves, refusals, re-cuts, uploads off, a resume");
  }

  /* --- 14. Activity: the pick running and the ones queued, on the plan and the strip ------------ */
  {
    const P = 13_000_020;
    const Q = 13_000_021;
    exported(P);
    exported(Q);
    let release = () => {};
    watching = new Promise((r) => (release = r));
    void flow.queuePick(P);
    void flow.queuePick(Q);
    await new Promise((r) => setImmediate(r));
    const planP = await plan(P);
    assert.deepEqual(
      { ...planP.activity, since: "" },
      { step: "pick", line: "starting the pick", since: "" },
    );
    assert.equal(planP.detail, "starting the pick", "the list's line is the step's own");
    const strip = (await flow.nightlyShortSummary()).activity;
    assert.deepEqual(
      strip.running.map((r) => [r.matchId, r.step]),
      [[P, "pick"]],
    );
    assert.deepEqual(strip.queued, [Q], "Q waits its turn");
    assert.ok((await plan(Q)).log.some((l) => l.text === "queued for the model — 1 ahead of it"));
    release();
    await flow.picksIdle();
    assert.deepEqual((await flow.nightlyShortSummary()).activity, { running: [], queued: [] });
    console.log("OK: the running pick is the plan's activity and the strip's; the queue is listed");
  }

  /* --- 15. Two saves at once: the second is refused, not interleaved ----------------------------- */
  {
    const R = 13_000_022;
    exported(R);
    writePick(R);
    config.nightlyUpload = "off";
    const [one, two] = await Promise.all([
      flow.saveHooks(R, { titleHook: "One heart left", shortHook: "First" }, chain),
      flow.saveHooks(R, { titleHook: "One heart left", shortHook: "Second" }, chain),
    ]);
    assert.equal(one, null);
    assert.deepEqual(two, {
      status: 409,
      error: "another save of this match is still being written — press Save again in a moment",
    });
    await flow.chainIdle(R);
    assert.equal(await readShortHook(dir(R), R), "First");
    console.log("OK: two saves racing — the second is refused and logged");

    /* --- 16. A hook changed during the render: the chain cuts again behind the new one --------- */
    let open = () => {};
    renderGate = new Promise((r) => (open = r));
    const before = renders.filter((r) => r.id === R).length;
    await call("PUT", "hooks", R, { titleHook: "One heart left", shortHook: "During" });
    await new Promise((r) => setTimeout(r, 20));
    await call("PUT", "hooks", R, { titleHook: "One heart left", shortHook: "After" });
    open();
    renderGate = Promise.resolve();
    await flow.chainIdle(R);
    assert.deepEqual(
      renders
        .filter((r) => r.id === R)
        .map((r) => r.hook)
        .slice(before),
      ["During", "After"],
      "the render in flight finishes, then the Short is cut again behind the hook saved meanwhile",
    );
    const rlog = (await plan(R)).log.map((l) => l.text);
    assert.ok(
      rlog.includes(
        "saved while the render step runs — it looks again when that ends (a changed hook re-cuts the Short)",
      ),
    );
    assert.ok(rlog.includes('the Short hook changed since the cut — cutting it again behind "After"'));
    config.nightlyUpload = "scheduled";
    console.log("OK: a hook saved mid-render re-cuts the Short once the render ends");
  }

  /* --- 17. Not exported: the pick is not made on nothing, the step says what to do -------------- */
  {
    const N = 13_000_023;
    mkdirSync(dir(N), { recursive: true });
    writeFileSync(path.join(dir(N), `match-${N}.title.txt`), "Chip | edcr vs doogile | MCSR Ranked 1v1\n");
    const picked = picks.length;
    await save(N, { titleHook: "One heart left", shortHook: "Nothing yet" });
    assert.equal(picks.length, picked, "the model is not asked to watch a video that is not there");
    const p = await plan(N);
    assert.equal(p.state, "failed");
    assert.deepEqual(
      p.errors.map((e) => [e.step, e.message]),
      [
        [
          "pick",
          "the long-form is not exported — press Re-encode MP4 on the Final video panel, then save the hooks again",
        ],
      ],
    );
    console.log(
      "OK: hooks saved before the export — the step fails with the fix, no heuristic pick is pinned",
    );
  }

  /* --- 18. The MCSR API down on save: nothing written, a 503 that says so -------------------------- */
  {
    const M = 13_000_024;
    exported(M);
    writePick(M);
    mcsrDown = true;
    const down = await call("PUT", "hooks", M, { titleHook: "One heart left", shortHook: "Down" });
    mcsrDown = false;
    assert.equal(down.status, 503);
    assert.match(
      down.payload.error!,
      /^the match record could not be read \(MCSR Ranked API \/matches\/13000024 -> 503.*\) — nothing was saved; save again once the MCSR API answers$/,
    );
    assert.equal(await readShortHook(dir(M), M), null, "nothing written");
    assert.ok(
      (await plan(M)).log.some(
        (l) => l.level === "warn" && l.text.startsWith("save refused: the match record"),
      ),
    );
    console.log("OK: the MCSR API down on save is a 503 with the fix, and nothing is written");
  }

  /* --- 19. A stuck pick: stopped by the watchdog, the heuristic stands in with why ---------------- */
  {
    const K = 13_000_025;
    exported(K);
    const limits = { ...flow.pickWatchdog };
    flow.pickWatchdog.stuckMs = 60;
    flow.pickWatchdog.everyMs = 15;
    const fallbacks: string[] = [];
    flow.setPicker(async (id, { signal, fallback }) => {
      if (fallback) {
        fallbacks.push(fallback);
        writePick(id, "heuristic");
        writeFileSync(
          path.join(dir(id), `short-${id}.pick-error.json`),
          JSON.stringify({ at: new Date().toISOString(), message: fallback }),
        );
        return;
      }
      // Hangs until stopped, as an ffmpeg with no time limit would.
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    });
    await flow.queuePick(K);
    flow.setPicker(standIn);
    Object.assign(flow.pickWatchdog, limits);
    assert.equal(fallbacks.length, 1);
    assert.match(
      fallbacks[0]!,
      /^the pick was stuck — nothing moved for \d+ min after "starting the pick" — and was stopped; Pick again asks the model afresh$/,
    );
    const k = await plan(K);
    assert.equal(k.state, "waiting-for-hook");
    assert.equal(k.pick?.source, "heuristic");
    assert.match(k.errors[0]!.message, /the pick was stuck/);
    assert.ok(k.log.some((l) => l.level === "error" && l.text.startsWith("the pick was stuck")));
    assert.equal(k.activity, undefined, "and nothing runs any more");
    console.log("OK: a pick that stops moving is stopped, and the heuristic stands in saying why");
  }

  /* --- 20. No sync.json: the CLI refuses before the API, with the command that writes it -------- */
  {
    const Y = 13_000_026;
    mkdirSync(dir(Y), { recursive: true });
    writePick(Y);
    writeFileSync(path.join(dir(Y), `short-${Y}.hook.txt`), "Down to the last heart\n");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const cwd = mkdtempSync(path.join(tmpdir(), "mcsr-shortcli-"));
    writeFileSync(path.join(cwd, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }));
    const cli = spawnSync(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "shorts", "generateShort.ts"), String(Y)],
      { cwd, env: cliEnv, encoding: "utf8", timeout: 60_000 },
    );
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(
      cli.stderr,
      new RegExp(`no sync\\.json for match ${Y} — .*npm run sync-status -- ${Y} writes it`),
    );
    console.log("OK: no sync.json — the Short is refused, not cut seconds off, and the fix named");
  }

  /* --- 21. The publish time: the operator's, kept for the upload — or moved on YouTube ---------- */
  {
    const put = (id: number, body: unknown) =>
      call("PUT", "publishat", id, body) as Promise<{
        status: number;
        payload: { error?: string; publishAt?: string | null; warnings?: string[]; message?: string };
      }>;
    const T = 13_000_027;
    exported(T);
    writePick(T);
    // Refused: a time already gone (NOW is 08:00 on the 24th), junk, a Short on its own, a move of nothing.
    assert.deepEqual(await put(T, { publishAt: "2026-09-24T07:59:00Z" }), {
      status: 400,
      payload: { error: "that time has passed — pick one in the future" },
    });
    assert.equal((await put(T, { publishAt: "next tuesday" })).status, 400);
    assert.equal((await put(T, { kind: "short", publishAt: "2026-09-30T19:00:00Z" })).status, 400);
    assert.equal((await put(T, { publishAt: "2026-09-30T19:00:00Z", move: true })).status, 409);
    // Kept, with the slot rule it breaks as a warning, not a refusal: A holds the 24th's 19:00.
    const kept = await put(T, { publishAt: "2026-09-24T21:10:00+02:00" });
    const clash =
      "another video is scheduled for that hour (2026-09-24 19:00 UTC) — they would split the browse impressions";
    assert.deepEqual(kept, {
      status: 200,
      payload: { publishAt: "2026-09-24T19:10:00.000Z", warnings: [clash] },
    });
    assert.deepEqual(await flow.publishTimeView(T, NOW), {
      state: "open",
      at: "2026-09-24T19:10:00.000Z",
      chosen: true,
      stored: true,
      why: null,
      warnings: [clash],
    });
    // Cleared: back to the next free slot.
    assert.deepEqual(await put(T, { publishAt: null }), { status: 200, payload: { publishAt: null } });
    const free = await flow.publishTimeView(T, NOW);
    assert.equal(free.chosen, false);
    assert.equal(free.stored, false);
    assert.match(free.at!, /T19:00:00\.000Z$/, "the ranked slot");
    // Chosen, then the hooks: the chain uploads at the operator's time, the Short 18 h after it.
    await put(T, { publishAt: "2026-09-27T17:45:00Z" });
    await save(T, { titleHook: "One heart left", shortHook: "Chosen line" });
    assert.deepEqual(
      sent.filter((x) => x.id === T).map((x) => [x.kind, x.publishAt]),
      [
        ["video", "2026-09-27T17:45:00.000Z"],
        ["short", "2026-09-28T11:45:00.000Z"],
      ],
    );
    assert.equal((await flow.publishTimeView(T, NOW)).state, "scheduled");

    // A time that has passed by the upload: the next free slot, said in the log and on the step.
    const U = 13_000_028;
    exported(U);
    writePick(U);
    writeFileSync(
      path.join(dir(U), `short-${U}.status.json`),
      JSON.stringify({ steps: {}, errors: [], publishAt: "2026-09-24T07:30:00.000Z" }),
    );
    const uView = await flow.publishTimeView(U, NOW);
    assert.match(
      uView.why!,
      /^your time 2026-09-24 07:30 UTC had passed — the next free slot instead, 2026-\d\d-\d\d 19:00 UTC$/,
    );
    // Still stored, so the kit offers "use the next free slot" to clear it (r2 #9).
    assert.equal(uView.stored, true);
    await save(U, { titleHook: "One heart left", shortHook: "Late line" });
    const late = sent.find((x) => x.id === U && x.kind === "video")!;
    assert.match(late.publishAt!, /T19:00:00\.000Z$/, "the slot, not the passed time");
    const uPlan = await plan(U);
    assert.equal(uPlan.state, "scheduled");
    assert.ok(
      uPlan.errors.some(
        (e) => e.step === "upload-video" && e.message.startsWith("your time 2026-09-24 07:30 UTC had passed"),
      ),
    );
    assert.ok(
      uPlan.log.some(
        (l) => l.level === "warn" && l.text.startsWith("your time 2026-09-24 07:30 UTC had passed"),
      ),
    );

    // On YouTube and scheduled: moved there on the press that says so, the Short with it.
    const tokenDir = mkdtempSync(path.join(tmpdir(), "mcsr-yt-token-"));
    process.env.YOUTUBE_TOKEN_FILE = path.join(tokenDir, "token.json");
    writeFileSync(
      process.env.YOUTUBE_TOKEN_FILE,
      JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
    );
    const statusPart = (publishAt: string) => ({
      uploadStatus: "processed",
      privacyStatus: "private",
      publishAt,
      license: "youtube",
      embeddable: true,
      publicStatsViewable: true,
      madeForKids: false,
      selfDeclaredMadeForKids: false,
    });
    const writable = (publishAt: string) => ({
      privacyStatus: "private",
      publishAt,
      embeddable: true,
      license: "youtube",
      publicStatsViewable: true,
      selfDeclaredMadeForKids: false,
    });
    ytVideos.set(`video-${T}`, {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-09-27T17:45:00.000Z"),
    });
    ytVideos.set(`short-${T}`, {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-09-28T11:45:00.000Z"),
    });
    const stale = await put(T, { publishAt: "2026-09-29T19:00:00Z" });
    assert.equal(stale.status, 409, "a plain Save never moves the live channel");
    assert.equal(ytCalls.length, 0);
    const moved = await put(T, { publishAt: "2026-09-29T21:00:00+02:00", move: true });
    assert.deepEqual(moved, {
      status: 200,
      payload: {
        publishAt: "2026-09-29T19:00:00.000Z",
        message:
          "YouTube has it for 2026-09-29 19:00 UTC (was 2026-09-27 17:45 UTC); the Short moved with it to 2026-09-30 13:00 UTC, 18 h after",
        // An earlier section's upload holds that hour: the move goes through and says so.
        warnings: [
          "another video is scheduled for that hour (2026-09-29 19:00 UTC) — they would split the browse impressions",
        ],
      },
    });
    assert.deepEqual(
      ytCalls.filter((c) => c.method === "PUT").map((c) => c.body),
      [
        { id: `video-${T}`, status: writable("2026-09-29T19:00:00.000Z") },
        { id: `short-${T}`, status: writable("2026-09-30T13:00:00.000Z") },
      ],
      "the whole status part back, with the new time",
    );
    assert.equal((await readUpload(T, "video"))!.publishAt, "2026-09-29T19:00:00.000Z");
    assert.equal((await readUpload(T, "short"))!.publishAt, "2026-09-30T13:00:00.000Z");
    assert.deepEqual((await plan(T)).uploads.video, {
      videoId: `video-${T}`,
      publishAt: "2026-09-29T19:00:00.000Z",
    });

    // Refused, nothing written: another channel's, and a video already out.
    ytVideos.get(`video-${T}`)!.channelId = "UCsomeoneelse";
    const theirs = await put(T, { publishAt: "2026-10-01T19:00:00Z", move: true });
    assert.equal(theirs.status, 409);
    assert.match(theirs.payload.error!, /belongs to channel UCsomeoneelse, not yours — nothing moved/);
    ytVideos.get(`video-${T}`)!.channelId = config.youtubeChannelId;
    const P = 13_000_029;
    mkdirSync(dir(P), { recursive: true });
    await writeUpload(P, {
      videoId: `video-${P}`,
      uploadedAt: "2026-09-20T19:00:00Z",
      publishAt: "2026-09-21T19:00:00Z",
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "t",
    });
    ytVideos.set(`video-${P}`, {
      channelId: config.youtubeChannelId,
      status: { ...statusPart("2026-09-21T19:00:00Z"), privacyStatus: "public" },
    });
    assert.deepEqual(await put(P, { publishAt: "2026-10-01T19:00:00Z", move: true }), {
      status: 409,
      payload: { error: `video-${P} is already public — nothing moved` },
    });
    assert.equal((await flow.publishTimeView(P, NOW)).state, "published");
    assert.equal(ytCalls.filter((c) => c.method === "PUT").length, 2, "no refusal wrote anything");

    // Up with its Short still to come: the move carries the chain's Short time with it.
    const Z = 13_000_031;
    exported(Z);
    writePick(Z);
    writeFileSync(path.join(dir(Z), `match-${Z}.title.edited.txt`), "One heart left | edcr vs doogile\n");
    await writeUpload(Z, {
      videoId: `video-${Z}`,
      uploadedAt: "2026-09-24T07:00:00Z",
      publishAt: "2026-09-26T19:00:00.000Z",
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "One heart left | edcr vs doogile",
    });
    ytVideos.set(`video-${Z}`, {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-09-26T19:00:00.000Z"),
    });
    const alone = await put(Z, { publishAt: "2026-10-01T19:00:00Z", move: true });
    assert.equal(
      alone.payload.message,
      "YouTube has it for 2026-10-01 19:00 UTC (was 2026-09-26 19:00 UTC); the Short is not up yet — it goes up for 2026-10-02 13:00 UTC, 18 h after",
    );
    await save(Z, { titleHook: "One heart left", shortHook: "Follows line" });
    assert.deepEqual(
      sent.filter((x) => x.id === Z).map((x) => [x.kind, x.publishAt]),
      [["short", "2026-10-02T13:00:00.000Z"]],
    );

    // A Finish pressed while a Move waits on YouTube takes its turn after it: unserialized, the
    // Move wrote back the record it read before the Finish, and the Finish's ledger was gone.
    const W = 13_000_093;
    mkdirSync(dir(W), { recursive: true });
    await writeUpload(W, {
      videoId: `video-${W}`,
      uploadedAt: "2026-09-24T07:00:00Z",
      publishAt: "2026-09-26T19:00:00.000Z",
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "t",
      source: "studio",
      finished: { playlists: null, comment: null, tags: null },
    });
    ytVideos.set(`video-${W}`, {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-09-26T19:00:00.000Z"),
    });
    let reply!: () => void;
    ytHold = new Promise((r) => (reply = r));
    const moving = put(W, { publishAt: "2026-10-03T19:00:00Z", move: true });
    const atYouTube = () => ytHold === null;
    for (let i = 0; !atYouTube() && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(atYouTube(), "the Move is at YouTube, its record read");
    const finishing = finishOnYouTube(W, `video-${W}`);
    await new Promise((r) => setTimeout(r, 100));
    reply();
    assert.equal((await moving).status, 200);
    const steps = await finishing;
    const wRec = (await readUpload(W, "video"))!;
    assert.equal(wRec.publishAt, "2026-10-03T19:00:00.000Z", "the Move's time");
    assert.deepEqual(wRec.finished, steps, "and the Finish's ledger, both kept");
    assert.match(String(steps.thumbnail), /left alone/);
    console.log(
      "OK: a Move and a Finish on one match take turns — neither puts back the other's stale record",
    );

    /* --- Review fixes (26 Sept 2026, publish-at-review.md) -------------------------------------- */
    const { _setChannelUploadsForTest } = await import("../youtube/channelUploads.js");
    const { _setPlayoffContextForTest } = await import("../playoffs/playoffs.js");
    const scanned = (id: number, videoId: string, privacyStatus: string, publishAt: string | null) => ({
      videoId,
      title: "t",
      publishedAt: "2026-09-20T10:00:00Z",
      description: `https://mcsrranked.com/matches/${id}`,
      privacyStatus,
      durationSec: 600,
      publishAt,
    });

    // #2: a stored time needs YouTube's hour of lead — it checks the time once the file is up.
    const L = 13_000_040;
    exported(L);
    writePick(L);
    assert.deepEqual(await put(L, { publishAt: "2026-09-24T08:30:00Z" }), {
      status: 400,
      payload: {
        error:
          "that is under an hour away — YouTube checks the time only once the file is up; pick a later one",
      },
    });
    writeFileSync(
      path.join(dir(L), `short-${L}.status.json`),
      JSON.stringify({ steps: {}, errors: [], publishAt: "2026-09-24T08:40:00.000Z" }),
    );
    const near = await flow.publishTimeView(L, NOW);
    assert.equal(near.chosen, false, "under the lead, the slot stands in");
    assert.match(
      near.why!,
      /^your time 2026-09-24 08:40 UTC was under an hour away — the next free slot instead/,
    );

    // #7: a time stored for a match not uploaded yet is a claim: another match is told of the clash…
    const X = 13_000_041;
    exported(X);
    writePick(X);
    assert.equal((await put(X, { publishAt: "2026-10-10T19:00:00Z" })).status, 200);
    assert.deepEqual((await put(L, { publishAt: "2026-10-10T19:20:00Z" })).payload.warnings, [
      "another video is scheduled for that hour (2026-10-10 19:00 UTC) — they would split the browse impressions",
    ]);
    // …and the chain says a chosen time's clash again at the upload (A holds the 24th's 19:00).
    const Y = 13_000_042;
    exported(Y);
    writePick(Y);
    await put(Y, { publishAt: "2026-09-24T19:30:00Z" });
    await save(Y, { titleHook: "One heart left", shortHook: "Clash line" });
    assert.equal(sent.find((x) => x.id === Y && x.kind === "video")!.publishAt, "2026-09-24T19:30:00.000Z");
    assert.ok(
      (await plan(Y)).errors.some(
        (e) =>
          e.step === "upload-video" &&
          e.message.startsWith("your time 2026-09-24 19:30 UTC: another video is scheduled for that hour"),
      ),
      "the clash is said at the upload",
    );

    // #9: with nightlyUpload not "scheduled" the chain ignores the time, and the kit says so.
    config.nightlyUpload = "private";
    const unused =
      'nightlyUpload is "private" on this box: the chain uploads private with no publish time — this time is for a paste into Studio';
    assert.deepEqual((await put(X, { publishAt: "2026-10-11T19:00:00Z" })).payload.warnings, [unused]);
    assert.deepEqual((await flow.publishTimeView(X, NOW)).warnings, [unused]);
    config.nightlyUpload = "scheduled";
    assert.deepEqual((await flow.publishTimeView(X, NOW)).warnings, []);
    // …and with uploads off altogether the chain stops before it (r2 #11).
    config.youtubeUploadEnabled = false;
    assert.deepEqual((await flow.publishTimeView(X, NOW)).warnings, [
      "youtubeUploadEnabled is false on this box: the chain does not upload — this time is for a paste into Studio",
    ]);
    config.youtubeUploadEnabled = true;

    // A scheduled Studio upload the scan paired, with no youtube.json: moved in Studio, not here.
    const S = 13_000_043;
    exported(S);
    ytVideos.set("studio-S", {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-09-30T19:00:00Z"),
    });
    const sVideo = scanned(S, "studio-S", "private", "2026-09-30T19:00:00Z");
    _setChannelUploadsForTest([sVideo]);
    assert.equal((await flow.publishTimeView(S, NOW)).state, "studio");
    const calls = ytCalls.length;
    assert.deepEqual(await put(S, { publishAt: "2026-10-03T19:00:00Z", move: true }), {
      status: 409,
      payload: { error: "uploaded in Studio, with no upload record here — move it in Studio" },
    });
    assert.equal(ytCalls.length, calls, "no API call");
    // Then the scan's record step (r3 #1): the record keeps the time, so the kit moves it and the
    // chain's Short is timed from it. Already backed up, so no rsync.
    mkdirSync(path.join(archive, String(S)), { recursive: true });
    await recordStudioUpload(S, sVideo);
    assert.equal((await readUpload(S))!.publishAt, "2026-09-30T19:00:00Z");
    const at = async (id: number) => {
      const v = await flow.publishTimeView(id, NOW);
      return [v.state, v.at];
    };
    assert.deepEqual(await at(S), ["scheduled", "2026-09-30T19:00:00Z"]);
    // A record written before it kept one (13172029, 13223455): the scan's entry for that video says it.
    await writeUpload(S, { ...(await readUpload(S))!, publishAt: null });
    assert.deepEqual(await at(S), ["scheduled", "2026-09-30T19:00:00Z"]);
    // Only for the record's own video: another video paired to the match says nothing about it.
    _setChannelUploadsForTest([{ ...sVideo, videoId: "studio-S2" }]);
    assert.deepEqual(await at(S), ["unscheduled", null]);

    // The record is the kit's word: its time passed, a public entry (YouTube drops the time once it
    // is out) leaves it published at the record's time (r2 #1)…
    const M = 13_000_044;
    exported(M);
    await writeUpload(M, {
      videoId: "video-M",
      uploadedAt: "2026-09-20T10:00:00Z",
      publishAt: "2026-09-21T19:00:00.000Z",
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "t",
    });
    ytVideos.set("video-M", {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-10-05T19:00:00Z"),
    });
    _setChannelUploadsForTest([scanned(M, "video-M", "public", null)]);
    assert.deepEqual(await at(M), ["published", "2026-09-21T19:00:00.000Z"]);
    // …but the scan's entry still scheduled means it was moved in Studio: that time, and Move (r3 #6).
    _setChannelUploadsForTest([scanned(M, "video-M", "private", "2026-10-05T19:00:00Z")]);
    assert.deepEqual(await at(M), ["scheduled", "2026-10-05T19:00:00Z"]);
    // #8 too: the move says which slot rules the new hour breaks (X's stored time holds the 11th's 19:00).
    const mMove = await put(M, { publishAt: "2026-10-11T19:10:00Z", move: true });
    assert.equal(mMove.status, 200, JSON.stringify(mMove.payload));
    assert.match(
      mMove.payload.message!,
      /^YouTube has it for 2026-10-11 19:10 UTC \(was 2026-10-05 19:00 UTC\)/,
    );
    assert.deepEqual(mMove.payload.warnings, [
      "another video is scheduled for that hour (2026-10-11 19:00 UTC) — they would split the browse impressions",
    ]);
    assert.deepEqual((await flow.publishTimeView(M, NOW)).warnings, mMove.payload.warnings, "and the view");
    assert.equal((await readUpload(M, "video"))!.publishAt, "2026-10-11T19:10:00.000Z");
    // The scan is hours old now and still says 10-05: the record's time ahead is the newer word.
    assert.deepEqual(await at(M), ["scheduled", "2026-10-11T19:10:00.000Z"]);
    // Pressed again untouched: YouTube already has that time, and nothing is written (r2 #8).
    const puts = ytCalls.filter((c) => c.method === "PUT").length;
    assert.match(
      (await put(M, { publishAt: "2026-10-11T19:10:00Z", move: true })).payload.message!,
      /^YouTube already has it for 2026-10-11 19:10 UTC;/,
    );
    assert.equal(ytCalls.filter((c) => c.method === "PUT").length, puts);

    // #10: a Short private with no time is not "already out"; one left scheduled before its video says so.
    const N = 13_000_045;
    exported(N);
    const rec = (videoId: string, publishAt: string | null) => ({
      videoId,
      uploadedAt: "2026-09-20T10:00:00Z",
      publishAt,
      privacyStatus: "private" as const,
      thumbnailVariant: null,
      title: "t",
    });
    await writeUpload(N, rec("video-N", "2026-10-06T19:00:00.000Z"));
    await writeUpload(N, rec("short-N", null), "short");
    ytVideos.set("video-N", {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-10-06T19:00:00Z"),
    });
    ytVideos.set("short-N", {
      channelId: config.youtubeChannelId,
      status: { ...statusPart("x"), publishAt: undefined },
    });
    _setChannelUploadsForTest([]);
    assert.match(
      (await put(N, { publishAt: "2026-10-07T19:00:00Z", move: true })).payload.message!,
      /; the Short did not move: short-N is private with no publish time — set one in Studio$/,
    );
    await writeUpload(N, rec("short-N", "2026-10-08T13:00:00.000Z"), "short");
    ytVideos.set("short-N", { channelId: "UCsomeoneelse", status: statusPart("2026-10-08T13:00:00Z") });
    assert.match(
      (await put(N, { publishAt: "2026-10-09T19:00:00Z", move: true })).payload.message!,
      /; the Short did not move: .* — it now goes out before the video \(2026-10-08 13:00 UTC\); move it in Studio to 2026-10-10 13:00 UTC$/,
    );
    // A teaser day (x6, the Short 2 h before): a Short left inside that head start is not "early";
    // one further ahead still is, and is told the teaser's own time.
    {
      const { writeExperiments } = await import("./experiments.js");
      writeExperiments({
        experiments: [],
        schedule: [{ date: "2026-10-11", experimentId: "x6", arm: "before", slot: { shortDelayHours: -2 } }],
      });
      await writeUpload(N, rec("short-N", "2026-10-11T18:00:00.000Z"), "short");
      assert.match(
        (await put(N, { publishAt: "2026-10-11T19:00:00Z", move: true })).payload.message!,
        /; the Short did not move: short-N belongs to channel UCsomeoneelse, not yours — nothing moved$/,
      );
      await writeUpload(N, rec("short-N", "2026-10-11T13:00:00.000Z"), "short");
      assert.match(
        (await put(N, { publishAt: "2026-10-11T19:30:00Z", move: true })).payload.message!,
        /; the Short did not move: .* — it now goes out before the video \(2026-10-11 13:00 UTC\); move it in Studio to 2026-10-11 17:30 UTC$/,
      );
      rmSync(path.join(media, ".experiments.json"));
    }

    // #12: a playoff game after game 1 has no time of its own; game 1 has.
    const G2 = 13_000_046;
    const G1 = 13_000_047;
    exported(G2);
    exported(G1);
    const ctx = (gameNo: number) => ({
      season: 11,
      round: "Round of 16",
      gameNo,
      bestOf: 5,
      firstTo: 3,
      seeds: [] as never,
      score: [0, 0] as [number, number],
    });
    _setPlayoffContextForTest(G2, ctx(2));
    _setPlayoffContextForTest(G1, ctx(1));
    assert.deepEqual(await put(G2, { publishAt: "2026-10-12T19:00:00Z" }), {
      status: 409,
      payload: {
        error: "a playoff game after game 1 — the series goes out as one video, so set the time on game 1",
      },
    });
    assert.equal((await flow.publishTimeView(G2, NOW)).state, "series-game");
    const g1 = await flow.publishTimeView(G1, NOW);
    assert.equal(g1.state, "open");
    // Its series goes out at the series' hour, joined or not yet (r2 #12).
    assert.match(g1.at!, /T23:00:00\.000Z$/);
    assert.equal((await put(G1, { publishAt: "2026-10-12T23:00:00Z" })).status, 200);

    /* --- Review round 3 (publish-at-review-r3.md) ------------------------------------------------ */
    // #3: no Move while the chain makes the Short: its upload takes the long-form's time as it starts.
    const Q = 13_000_048;
    exported(Q);
    writePick(Q);
    writeFileSync(path.join(dir(Q), `match-${Q}.title.edited.txt`), "One heart left | edcr vs doogile\n");
    await writeUpload(Q, rec(`video-${Q}`, "2026-10-13T19:00:00.000Z"));
    ytVideos.set(`video-${Q}`, {
      channelId: config.youtubeChannelId,
      status: statusPart("2026-10-13T19:00:00.000Z"),
    });
    let openRender = () => {};
    renderGate = new Promise((r) => (openRender = r));
    await call("PUT", "hooks", Q, { titleHook: "One heart left", shortHook: "Mid-render line" });
    const qPuts = ytCalls.filter((c) => c.method === "PUT").length;
    assert.deepEqual(await put(Q, { publishAt: "2026-10-14T19:00:00Z", move: true }), {
      status: 409,
      payload: { error: "the Short is being made or sent right now — move it once the chain has finished" },
    });
    assert.equal(ytCalls.filter((c) => c.method === "PUT").length, qPuts, "nothing moved");
    openRender();
    renderGate = Promise.resolve();
    await flow.chainIdle(Q);
    assert.deepEqual(
      sent.filter((x) => x.id === Q).map((x) => [x.kind, x.publishAt]),
      [["short", "2026-10-14T13:00:00.000Z"]],
      "the Short 18 h after the time the video still has",
    );

    // #2: an upload on its way refuses a Save and a clear (checked after the last await before the write).
    const B = 13_000_049;
    exported(B);
    writePick(B);
    let openUpload = () => {};
    uploadGate = new Promise((r) => (openUpload = r));
    await call("PUT", "hooks", B, { titleHook: "One heart left", shortHook: "Upload line" });
    for (let i = 0; i < 500 && (await flow.matchRowShort(B)).shortDetail !== "uploading the long-form"; i++)
      await new Promise((r) => setTimeout(r, 10));
    const busy = {
      status: 409,
      payload: {
        error: "an upload of this match is being sent right now — once it is up, move it on YouTube",
      },
    };
    assert.deepEqual(await put(B, { publishAt: "2026-10-15T19:00:00Z" }), busy);
    assert.deepEqual(await put(B, { publishAt: null }), busy);
    openUpload();
    uploadGate = Promise.resolve();
    await flow.chainIdle(B);

    // #8: a private room whose bracket cannot be read (this stub serves none) may be a game after
    // game 1, whose time is game 1's: nothing is stored. The field still shows.
    const PR = 13_000_050;
    exported(PR);
    privateRooms.add(PR);
    assert.deepEqual(await put(PR, { publishAt: "2026-10-16T19:00:00Z" }), {
      status: 503,
      payload: {
        error:
          "the playoff bracket could not be read, so whether this private-room match is a game after game 1 is unknown — try again in a minute",
      },
    });
    assert.equal(flow.readStatus(PR).publishAt, undefined);
    assert.equal((await flow.publishTimeView(PR, NOW)).state, "open");

    delete process.env.YOUTUBE_TOKEN_FILE;
    rmSync(tokenDir, { recursive: true, force: true });
    console.log(
      "OK: the publish time — kept for the upload, warned not refused, moved on YouTube with its Short",
    );
  }

  /* --- A blocked match: no hooks, so no pick, no render and no upload (config.blockedPlayers) --- */
  {
    const BL = 13_000_060;
    exported(BL);
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["edcr"]; // the fixture's own left player, any case
    const refused = await save(BL, { titleHook: "Blocked", shortHook: "Also blocked" });
    assert.equal(refused.status, 403);
    assert.match((refused.payload as { error: string }).error, /blocked player/);
    assert.ok(!picks.some((p) => p.id === BL), "the model is never asked");
    assert.ok(!renders.some((r) => r.id === BL), "and nothing is rendered");
    assert.ok(!sent.some((s) => s.id === BL), "or uploaded");
    config.blockedPlayers = savedBlocked;
    const unblocked = await save(BL, { titleHook: "Not blocked", shortHook: "Still fine" });
    assert.equal(unblocked.status, 202, "unblocked, the save goes through");
    console.log("OK: a blocked match never gets its hooks saved, so the chain never starts");
  }

  /* --- Two chains must not claim the same publish slot (7 Oct 2026: four hooks saved inside one
     second started four chains whose renders all finished together, and every one of them
     computed "the next free slot" before any other had written one — three long-forms landed on
     the same 19:00 UTC hour) ------------------------------------------------------------------- */
  {
    const F = 13_000_061;
    const G = 13_000_062;
    exported(F);
    exported(G);
    let openUpload = () => {};
    uploadGate = new Promise((r) => (openUpload = r));
    await call("PUT", "hooks", F, { titleHook: "One heart left", shortHook: null, noShort: true });
    await call("PUT", "hooks", G, { titleHook: "One heart left", shortHook: null, noShort: true });
    // Both chains must have finished picking their slot and called `upload` — the window the real
    // bug raced in — before either is let through.
    for (let i = 0; i < 500 && !(uploadCalls.includes(F) && uploadCalls.includes(G)); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(uploadCalls.includes(F) && uploadCalls.includes(G), "both reached the upload step");
    openUpload();
    uploadGate = Promise.resolve();
    await Promise.all([flow.chainIdle(F), flow.chainIdle(G)]);
    const slotOf = (id: number) => sent.find((s) => s.id === id && s.kind === "video")?.publishAt;
    assert.ok(slotOf(F) && slotOf(G), "both videos uploaded");
    assert.notEqual(slotOf(F), slotOf(G), "two chains must not claim the same publish slot");
    console.log("OK: concurrent chains claim different publish slots, not the same one");
  }

  /* --- Auto-hooks: the operator's own grant (8 Oct 2026) — a pick nobody has looked at for
     `autoHooksAfterHours` gets saved by itself, exactly as the dashboard's own Save would. The
     title hook is `titleOptions.ts`'s own first option (18 Oct 2026); its model call is never
     exercised here — every match below gets its own `title-options.json` seeded on disk, so the
     tick reads that cache instead of spawning the real `claude` CLI. The "noShort" path and the
     upper-casing rule are pinned in autoHooks.test.ts, which needs no network. ----------------- */
  {
    config.autoHooksAfterHours = 6;
    const AH_NOW = Date.now();
    const dueAt = (hoursAgo: number) => new Date(AH_NOW - hoursAgo * 3600_000).toISOString();
    const customPick = (id: number, over: Partial<ShortPick>) =>
      writeFileSync(path.join(dir(id), `short-${id}.pick.json`), JSON.stringify({ ...pickOf(id), ...over }));
    /** Seeds the cache `titleOptions.ts` reads, so auto-hooks never calls the real model here. */
    const seedTitleOptions = (
      id: number,
      options: string[],
      source: ("nicknames" | "model" | "chip")[] = options.map(() => "model" as const),
    ) => writeFileSync(path.join(dir(id), "title-options.json"), JSON.stringify({ options, source }));

    // Not yet due: an hour-old pick is left alone.
    const AH1 = 13_000_070;
    exported(AH1);
    customPick(AH1, { createdAt: dueAt(1) });
    await flow.autoHooksTick(chain, AH_NOW);
    assert.ok(!flow.readStatus(AH1).hooksSavedAt, "an hour-old pick is not due at 6 h");
    assert.ok(!flow.readStatus(AH1).autoHooks);

    // Due: the title is titleOptions' own first option; its own Short suggestion is a denied
    // word, so the Short falls back to a hooks.ts chip.
    const AH2 = 13_000_071;
    exported(AH2);
    seedTitleOptions(AH2, ["A clean one"]);
    customPick(AH2, { createdAt: dueAt(7), hookSuggestion: "the asian pulls ahead" });
    // The Telegram title picker's own seam (src/telegram/titlePicker.ts): fired once, after the
    // save is already on disk, with exactly the title that was saved.
    const autoHooksSaved: Array<{ matchId: number; titleHook: string }> = [];
    flow.setAutoHooksSavedHook((matchId, titleHook) => void autoHooksSaved.push({ matchId, titleHook }));
    await flow.autoHooksTick(chain, AH_NOW);
    await flow.chainIdle(AH2);
    assert.deepEqual(
      autoHooksSaved,
      [{ matchId: AH2, titleHook: "A clean one" }],
      "the hook fired once, after the save",
    );
    flow.setAutoHooksSavedHook(() => undefined);
    const st2 = flow.readStatus(AH2);
    assert.ok(st2.hooksSavedAt, "a due pick with a clean candidate is saved");
    assert.equal(st2.autoHooks?.titleHook, "A clean one", "titleOptions' own first option");
    assert.equal(st2.autoHooks?.source.title, "model");
    assert.ok(st2.autoHooks?.shortHook, "a chip stood in for the model's own denied Short hook");
    assert.equal(st2.autoHooks?.source.short, "chip");
    assert.ok(
      sent.some((s) => s.id === AH2 && s.kind === "video"),
      "the chain ran as if Save had been pressed",
    );
    const rows = await flow.listAutoHooks(AH_NOW - 3600_000, AH_NOW + 3600_000);
    const row2 = rows.find((r) => r.matchId === AH2);
    assert.ok(row2, "listAutoHooks reports the save");
    assert.equal(row2!.titleHook, "A clean one");
    assert.equal(row2!.stillCurrent, true, "nobody has edited it since");
    assert.equal(row2!.uploaded, true);
    console.log("OK: auto-hooks saves titleOptions' own first option");

    // The operator saves by hand while the tick is still choosing (its suggestions wait on the
    // API's user lookups): the typed hooks stand, and nothing reads as failed — not an auto save
    // over them, not the 409 an auto save would get against a hook the upload has since locked.
    const typedMeanwhile = 13_000_069; // the only due match here: AH2 is saved, AH3 isn't yet
    exported(typedMeanwhile);
    seedTitleOptions(typedMeanwhile, ["A clean one"]);
    customPick(typedMeanwhile, { createdAt: dueAt(7) });
    duringUserFetch = async () => {
      assert.equal(
        (await save(typedMeanwhile, { titleHook: "OPERATOR TYPED", shortHook: "OPERATOR SHORT" })).status,
        202,
      );
    };
    await flow.autoHooksTick(chain, AH_NOW);
    assert.equal(duringUserFetch, null, "the save ran inside the tick's own user lookup");
    const stTyped = flow.readStatus(typedMeanwhile);
    assert.ok(stTyped.hooksSavedAt);
    assert.ok(!stTyped.autoHooks, "nothing was auto-saved");
    assert.notEqual(stTyped.steps.hooks?.state, "failed");
    assert.match(
      readFileSync(path.join(dir(typedMeanwhile), `match-${typedMeanwhile}.title.edited.txt`), "utf8"),
      /^OPERATOR TYPED/,
    );
    assert.equal(await readShortHook(dir(typedMeanwhile), typedMeanwhile), "OPERATOR SHORT");
    console.log("OK: a hand save made while auto-hooks is choosing is never overwritten or marked failed");

    // No candidate survives at all (titleOptions' own cache says so): the hooks step fails with
    // its own message, and nothing is saved.
    const AH3 = 13_000_072;
    exported(AH3);
    seedTitleOptions(AH3, [], []);
    customPick(AH3, { createdAt: dueAt(7) });
    await flow.autoHooksTick(chain, AH_NOW);
    const st3 = flow.readStatus(AH3);
    assert.ok(!st3.hooksSavedAt, "nothing was saved");
    assert.equal(st3.steps.hooks?.state, "failed");
    assert.match(st3.errors[0]?.message ?? "", /no suggested hook passed/);
    const plan3 = await plan(AH3);
    assert.equal(plan3.state, "failed");
    assert.match(plan3.detail ?? "", /no suggested hook passed/);
    console.log("OK: no candidate passing fails the hooks step and saves nothing");

    // Each skip reason, all otherwise due.
    const hidden = 13_000_073;
    exported(hidden);
    customPick(hidden, { createdAt: dueAt(7) });
    setHidden(hidden, true);
    await flow.autoHooksTick(chain, AH_NOW);
    assert.ok(!flow.readStatus(hidden).hooksSavedAt, "a hidden match is left alone");
    // Left hidden (not restored): unhidden, it would be a due, unguarded pick for every later
    // tick in this file, which would reach titleOptions with no cache seeded for it.

    const onChannel = 13_000_074;
    exported(onChannel);
    customPick(onChannel, { createdAt: dueAt(7) });
    await writeUpload(
      onChannel,
      {
        videoId: "adopted",
        uploadedAt: new Date().toISOString(),
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: "t",
      },
      "video",
    );
    await flow.autoHooksTick(chain, AH_NOW);
    assert.ok(
      !flow.readStatus(onChannel).hooksSavedAt,
      "already on the channel (an adopted draft): never touched",
    );

    const blockedMatch = 13_000_075;
    exported(blockedMatch);
    customPick(blockedMatch, { createdAt: dueAt(7) });
    // Seeded so that once config.blockedPlayers is restored below, a later tick sweeping this
    // still-due pick again never reaches the real model for it.
    seedTitleOptions(blockedMatch, [], []);
    const savedBlocked2 = config.blockedPlayers;
    config.blockedPlayers = ["edcr"]; // the fixture's own left player
    await flow.autoHooksTick(chain, AH_NOW);
    config.blockedPlayers = savedBlocked2;
    assert.ok(!flow.readStatus(blockedMatch).hooksSavedAt, "a blocked player's match is never auto-saved");

    const noExport = 13_000_076;
    mkdirSync(dir(noExport), { recursive: true });
    customPick(noExport, { createdAt: dueAt(7) });
    await flow.autoHooksTick(chain, AH_NOW);
    assert.ok(!flow.readStatus(noExport).hooksSavedAt, "not exported yet: nothing to save hooks for");

    const staleExport = 13_000_077;
    exported(staleExport);
    utimesSync(
      path.join(dir(staleExport), "sync.json"),
      new Date(Date.now() + 5000),
      new Date(Date.now() + 5000),
    );
    customPick(staleExport, { createdAt: dueAt(7) });
    await flow.autoHooksTick(chain, AH_NOW);
    assert.ok(
      !flow.readStatus(staleExport).hooksSavedAt,
      "a stale export is re-encoded first, not auto-saved over",
    );
    console.log(
      "OK: hidden, already-on-the-channel, blocked, unexported and stale-export matches are all skipped",
    );

    /* --- Review fix (8 Oct 2026): an unjoined series game 1 must never reach saveHooks, and any
       refusal that does reach it must read as a failed "hooks" step, not vanish into a log line
       nothing reads — `gatherNeedsYou` reads `status.steps`, not the chain log. --------------- */
    {
      const { _setPlayoffContextForTest } = await import("../playoffs/playoffs.js");
      const { readShortLog } = await import("../shorts/shortLog.js");
      const ctx = {
        season: 11,
        round: "Round of 16",
        gameNo: 1,
        bestOf: 5,
        firstTo: 3,
        seeds: [] as never,
        score: [0, 0] as [number, number],
      };

      // A playoff game 1 the bracket already recognises, with no series.json yet (the join
      // hasn't happened): `saveHooks` would refuse it with SERIES_GAME every single tick,
      // forever, until the join catches up — `autoHooksTick` must skip it before ever calling
      // saveHooks, the same pre-check `shortPlan` already makes.
      const seriesGame1 = 13_000_078;
      exported(seriesGame1);
      customPick(seriesGame1, { createdAt: dueAt(7) });
      _setPlayoffContextForTest(seriesGame1, ctx);
      await flow.autoHooksTick(chain, AH_NOW);
      let st = flow.readStatus(seriesGame1);
      assert.ok(!st.hooksSavedAt, "an unjoined series game 1 is never auto-saved");
      assert.ok(!st.steps.hooks, "skipped before saveHooks — no failed step, no SERIES_GAME spam");
      assert.ok(!st.autoHooks);
      // The discriminating check: a failed step this clean could also be the old swallow-bug
      // (saveHooks refused, the refusal only logged) — so pin that saveHooks, and the "save
      // refused" log line it would produce, were never reached at all.
      assert.ok(
        !readShortLog(seriesGame1).some((l) => l.text.includes("save refused")),
        "the pre-check skips it before saveHooks is ever called, not after",
      );
      // A later tick (the bracket still not joined) leaves it exactly as untouched, not retried
      // into a growing errors list.
      await flow.autoHooksTick(chain, AH_NOW);
      st = flow.readStatus(seriesGame1);
      assert.ok(!st.steps.hooks && st.errors.length === 0);
      console.log("OK: an unjoined series game 1 is skipped before saveHooks, every tick");

      // A refusal saveHooks does reach (anything other than the pre-filtered series case — here,
      // the title file's own path is a directory, so the write saveHooks does fails) must surface
      // as a failed "hooks" step: that is what `gatherNeedsYou`'s `failedStepItems` reads, the one
      // place the operator said he acts from. Before this fix, `autoSaveHooks` only logged the
      // refusal and returned — invisible to the report, retried forever.
      const refused = 13_000_079;
      exported(refused);
      customPick(refused, { createdAt: dueAt(7) });
      seedTitleOptions(refused, ["A clean one"]);
      mkdirSync(path.join(dir(refused), `match-${refused}.title.edited.txt`), { recursive: true });
      await flow.autoHooksTick(chain, AH_NOW);
      const stRefused = flow.readStatus(refused);
      assert.ok(!stRefused.hooksSavedAt, "the write failed — nothing was saved");
      assert.equal(stRefused.steps.hooks?.state, "failed");
      assert.match(stRefused.errors[0]?.message ?? "", /^auto-hooks: save refused/);
      const planRefused = await plan(refused);
      assert.equal(planRefused.state, "failed");
      console.log("OK: a non-series saveHooks refusal still fails the hooks step, not just the log");

      // One match whose own auto-save throws instead of returning a controlled result (here: a
      // corrupted match directory, its status file's own ".part" write target replaced by a
      // directory, so every `updateStatus` call for it throws EISDIR — including the one
      // `autoSaveHooks` makes straight after a successful `saveHooks`, with no try/catch around
      // it) must not stop the tick from reaching matches due after it — same as the getMatch
      // guard a few lines above this one in the source.
      const broken = 13_000_080;
      const healthy = 13_000_081; // sorts after `broken`: listProcessedMatchIds() is numeric order
      exported(broken);
      customPick(broken, { createdAt: dueAt(7) }); // an ordinary due pick: a candidate is found
      seedTitleOptions(broken, ["A clean one"]);
      mkdirSync(path.join(dir(broken), `short-${broken}.status.json.part`), { recursive: true });
      exported(healthy);
      customPick(healthy, { createdAt: dueAt(7) });
      seedTitleOptions(healthy, ["A clean one"]);
      await flow.autoHooksTick(chain, AH_NOW);
      await flow.chainIdle(healthy);
      assert.ok(!flow.readStatus(broken).hooksSavedAt, "the broken match itself never saved");
      assert.ok(flow.readStatus(healthy).hooksSavedAt, "a later due match is still reached and saved");
      console.log("OK: one match throwing out of autoSaveHooks doesn't starve the matches due after it");
    }

    /* --- Weak sync (15 Oct 2026): 14178549 went up ~1.4 s out of step on a 0.1 countdown read,
       hooks saved by auto-hooks. A weak sync nobody set by hand is held for a human now. ------- */
    {
      const { gatherFacts } = await import("../telegram/facts.js");
      const { readShortLog } = await import("../shorts/shortLog.js");
      const needsYou = async () => {
        const facts = await gatherFacts(AH_NOW, AH_NOW - 86_400_000, ["needsYou"]);
        assert.ok(facts.needsYou.ok, JSON.stringify(facts.needsYou));
        return facts.needsYou.ok ? facts.needsYou.data.items : [];
      };
      /** Due, exported after this sync was written (so not a stale export). */
      const dueWithSync = (id: number, sync: { confidence: number; source: string }) => {
        exported(id);
        writeFileSync(
          path.join(dir(id), "sync.json"),
          JSON.stringify({ left: 150, right: 151.42, detail: "", ...sync }),
        );
        customPick(id, { createdAt: dueAt(7) });
      };
      const reExport = (id: number) => {
        const final = path.join(dir(id), `final-${id}.mp4`);
        utimesSync(final, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      };

      const weak = 13_000_083;
      const fixedLater = 13_000_084;
      dueWithSync(weak, { confidence: 0.1, source: "countdown" });
      dueWithSync(fixedLater, { confidence: 0, source: "coarse" });
      await flow.autoHooksTick(chain, AH_NOW);
      await flow.autoHooksTick(chain, AH_NOW);
      for (const id of [weak, fixedLater]) {
        const st = flow.readStatus(id);
        assert.ok(!st.hooksSavedAt && !st.autoHooks, `${id}: a weak sync is never auto-saved`);
        assert.match(st.syncHold?.detail ?? "", /waiting on the sync/);
        assert.equal(
          readShortLog(id).filter((l) => /waiting on the sync/.test(l.text)).length,
          1,
          `${id}: logged once, not every tick`,
        );
        assert.ok(!sent.some((s) => s.id === id), `${id}: nothing uploads`);
      }
      let items = await needsYou();
      assert.deepEqual(
        items.filter((i) => i.text === "sync needs a look before it can upload").map((i) => i.matchId),
        [weak, fixedLater],
        "one Needs-you line per held match",
      );
      console.log("OK: weak sync, not hand-set: auto-hooks saves nothing, logs it once, Needs-you lists it");

      // The hand fix (the sync editor's save: manual, confidence 1), then the re-export it needs.
      writeFileSync(
        path.join(dir(fixedLater), "sync.json"),
        JSON.stringify({ left: 150, right: 151.42, detail: "", confidence: 1, source: "manual" }),
      );
      reExport(fixedLater);
      seedTitleOptions(fixedLater, ["A clean one"]);
      const manual = 13_000_085;
      const sound = 13_000_086;
      dueWithSync(manual, { confidence: 1, source: "manual" });
      dueWithSync(sound, { confidence: 0.9, source: "countdown" });
      seedTitleOptions(manual, ["A clean one"]);
      seedTitleOptions(sound, ["A clean one"]);
      await flow.autoHooksTick(chain, AH_NOW);
      await Promise.all([fixedLater, manual, sound].map((id) => flow.chainIdle(id)));
      for (const id of [fixedLater, manual, sound]) {
        const st = flow.readStatus(id);
        assert.ok(st.hooksSavedAt && st.autoHooks, `${id}: a sound or hand-set sync proceeds`);
        assert.equal(st.syncHold, undefined, `${id}: no hold left behind`);
        assert.ok(
          sent.some((s) => s.id === id && s.kind === "video"),
          `${id}: the chain ran`,
        );
      }
      items = await needsYou();
      assert.ok(!items.some((i) => i.matchId === fixedLater), "the fixed match leaves Needs-you");
      console.log(
        "OK: a hand-set sync (manual, confidence 1) and a sound countdown read proceed; a fixed hold clears",
      );

      // The operator's own Save is never refused on a weak sync — the dashboard warns (syncWeak).
      assert.equal((await plan(weak)).syncWeak, true);
      assert.equal(
        (await save(weak, { titleHook: "Who blinks first?", shortHook: "WHO BLINKS?" })).status,
        202,
      );
      await flow.chainIdle(weak);
      assert.ok(flow.readStatus(weak).hooksSavedAt, "the typed save saved");
      assert.ok(!(await needsYou()).some((i) => i.matchId === weak), "saved: off Needs-you");
      console.log("OK: a typed save on a weak-sync match still saves, and leaves Needs-you");
    }
  }

  /* --- Hand mode (config.shortsByHand, 11 Oct 2026): "you're gonna make the shorts from now on" */
  {
    const hadHandMode = config.shortsByHand;
    config.shortsByHand = true;
    try {
      const H = 13_000_100;
      exported(H);
      const savedHand = await save(H, { titleHook: "Hand mode hook", shortHook: "irrelevant" });
      assert.equal(savedHand.status, 202);
      assert.ok(!picks.some((p) => p.id === H), "hand mode never queues a model pick");
      assert.ok(!renders.some((r) => r.id === H), "hand mode never renders its own Short");

      // The long-form uploads at its slot without waiting on the Short at all.
      const videoSent = sent.find((s) => s.id === H && s.kind === "video");
      assert.ok(videoSent, "the long-form uploaded on its own");
      assert.ok(!sent.some((s) => s.id === H && s.kind === "short"), "the Short has not uploaded yet");
      const videoRecord = await readUpload(H, "video");
      assert.ok(videoRecord, "the long-form's own upload record exists");

      const waiting = await plan(H);
      assert.equal(waiting.state, "rendering");
      assert.match(waiting.detail ?? "", /waiting for the hand-made Short/);
      assert.equal(
        flow.readStatus(H).steps["upload-short"],
        undefined,
        "no failed/off state on upload-short while waiting — no Needs-you noise",
      );

      // npm run short:hand's own output, dropped straight into the match directory — handShort.ts
      // is tested on its own (handShort.test.ts); only the chain's reaction matters here.
      writeFileSync(path.join(dir(H), `short-${H}.mp4`), "hand-made-short-bytes");
      writeFileSync(
        path.join(dir(H), `short-${H}.hand.json`),
        JSON.stringify({
          hook: "Hand-cut hook",
          builtAt: "2026-10-11T12:00:00.000Z",
          windowMatchSec: [300, 325],
          pov: "left",
        }),
      );
      writeFileSync(
        path.join(dir(H), `short-${H}.title.txt`),
        "Hand-cut hook | edcr vs doogile #mcsr #minecraft\n",
      );
      writeFileSync(
        path.join(dir(H), `short-${H}.description.txt`),
        "edcr vs doogile, hand-cut short.\nmatch page: https://example.com/13000100\n#mcsr #minecraft\n",
      );

      // The saved-but-irrelevant shortHook ("irrelevant", above) must drive nothing: the title
      // stays exactly what the hand file carries even though short-<id>.hook.txt also exists —
      // and the "whole match" link still lands, the same as any other Short's.
      const text = await uploadTextFor(H, "short");
      assert.equal(text.title, "Hand-cut hook | edcr vs doogile #mcsr #minecraft");
      assert.ok(text.description.startsWith("edcr vs doogile, hand-cut short.\n"));
      assert.ok(text.description.includes(`the whole match: https://youtu.be/${videoRecord!.videoId}`));

      // Nothing on disk tells this process the files landed — shortTick notices on its own tick.
      await flow.shortTick(chain, NOW);
      await flow.chainIdle(H);

      const shortSent = sent.find((s) => s.id === H && s.kind === "short");
      assert.ok(shortSent, "shortTick resumed the chain once the hand files landed");
      const expectedShortAt = flow
        .shortPublishAt(
          { videoId: videoRecord!.videoId, publishAt: videoSent!.publishAt!, privacyStatus: "private" },
          NOW,
        )!
        .toISOString();
      assert.equal(shortSent!.publishAt, expectedShortAt, "the Short's publish time, as any Short's");

      assert.equal((await plan(H)).state, "scheduled");
      console.log(
        "OK: hand mode — the long-form uploads alone, the Short waits, then goes up from the hand files",
      );

      // A leftover short-<id>.pick-error.json from before hand mode was switched on (or from
      // shortsRoutes.ts's own now-gated "pick" route) must never feed the daily retry: that
      // would force a full model watch on a window nothing here ever renders.
      const HR = 13_000_102;
      exported(HR);
      writePick(HR, "heuristic");
      writeFileSync(
        path.join(dir(HR), `short-${HR}.pick-error.json`),
        JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString(), message: "stand-in failure" }),
      );
      picks.length = 0;
      await flow.shortTick(chain, NOW + 72 * 3600_000);
      assert.ok(!picks.some((p) => p.id === HR), "hand mode never retries a leftover pick-error");
      console.log("OK: hand mode — shortTick's daily pick-retry never spends a model watch");

      // Off is today's chain, byte for byte: the whole suite above ran with this on only inside
      // this block, so every earlier section already pins the default-off path unchanged.
    } finally {
      config.shortsByHand = hadHandMode;
    }
  }
} finally {
  rmSync(media, { recursive: true, force: true });
}

console.log("shortFlow: all checks passed");
