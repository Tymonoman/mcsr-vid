// Contract test for the chain's half of the publish slot (src/dashboard/shortFlow.ts: `claimSlot`
// behind `startChain`, `setPublishTime`, `publishTimeView`), written from the docs alone — CLAUDE.md
// "nightlyUpload" + "Publish kit", handbook/claude-md-reference.md's long form of both (7 Oct 2026
// claimSlot paragraph, 26 Sept 2026 Publish at paragraph). The module's own name is taken by the
// Short-chain contract (shortFlow.contract.test.ts), hence `.publishSlot.`.
//
// A temp media dir; the MCSR API stubbed at fetch with a real match (src/fixtures/match-12730175.json,
// seats swapped for synthetic uuids where a test needs two different pairs); the uploader replaced
// by a stand-in that records what it was asked and writes the record the real one writes. Nothing
// reaches YouTube. publishSlot.contract.test.ts holds P1–P10 (the slot itself).
//
// The promises the docs make (P-numbers shared with publishSlot.contract.test.ts):
//  P11 nightlyUpload "scheduled": once the hooks are saved the chain uploads PRIVATE, scheduled
//      for the next free slot (19:00 UTC ranked / 23:00 series) or the kit's Publish at time.
//  P12 The Short goes up 18 h after the long-form's time.
//  P13 "private" = no publish time; "off" = the chain stops after the render (nothing uploads).
//  P14 Picking the free slot and claiming it is one serialised step (`claimSlot`), so concurrent
//      chains never collide on an hour — the 7 Oct incident was four hooks saved inside a second.
//  P15 The claim is written before the slow upload starts (a concurrent pick sees it) and clears
//      once the upload-video step settles, done or failed (a restart's resume included).
//  P16 The operator's own chosen time is untouched by claimSlot — already a claim on disk.
//  P17 Concurrent chains of the two kinds share a day: the test is the day AND the hour. A series
//      of the same pair as a ranked video in flight is pushed seriesPairGapDays, and the chain's
//      log says so; the kit says so beside the slot.
//  P18 Publish at is editable, stored in UTC as `publishAt` in short-<id>.status.json; the slot
//      rules come back as warnings, never refusals; the chain takes it while it is an hour ahead
//      (MIN_LEAD_MS) — Save "refuses less" — else the next free slot.
//
// Not reached from here: `GET /api/publishkit/:id` itself lives in server.ts (booting it is not
// hermetic); its `publish` field is `publishTimeView` verbatim, which is what is driven below.
// "nightlyUpload not writable from Settings" is already pinned by settings.test.ts.
//
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/shortFlow.publishSlot.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchInfo } from "../api/types.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-slotchain-contract-"));
config.mediaDir = media;
const ownArchive = process.env.MCSR_ARCHIVE_DIR
  ? null
  : mkdtempSync(path.join(tmpdir(), "mcsr-slotchain-archive-"));
if (ownArchive) process.env.MCSR_ARCHIVE_DIR = ownArchive;
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
/** Ids served with other seats than the fixture's own pair. */
const seats = new Map<number, [string, string]>();
/** Ids whose API answer takes a real (macrotask) while, like the network does. */
const slow = new Set<number>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (!m) throw new Error(`unexpected fetch: ${url}`);
  const id = Number(m[1]);
  if (slow.has(id)) await new Promise((r) => setTimeout(r, 60));
  const pair = seats.get(id);
  const players = pair ? fixture.players.map((p, i) => ({ ...p, uuid: pair[i]! })) : fixture.players;
  return new Response(JSON.stringify({ status: "success", data: { ...fixture, id, changes: [], players } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const flow = await import("./shortFlow.js");
const { writeUpload, readUpload } = await import("../youtube/youtubeStore.js");
const { publishSlotFor } = await import("../youtube/publishSlot.js");
const { readShortLog } = await import("../shorts/shortLog.js");
type Deps = import("./shortFlow.js").ChainDeps;

const DAY = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY);
const dir = (id: number) => path.join(media, String(id));
const statusPath = (id: number) => path.join(dir(id), `short-${id}.status.json`);

/** An exported match whose hooks are saved — what the chain needs before it uploads. */
function ready(
  id: number,
  o: { series?: boolean; short?: boolean; pair?: [string, string]; publishAt?: string } = {},
) {
  if (o.pair) seats.set(id, o.pair);
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(path.join(dir(id), o.series ? `series-${id}.mp4` : `final-${id}.mp4`), "x");
  if (o.series) writeFileSync(path.join(dir(id), "series.json"), JSON.stringify({ games: [] }));
  writeFileSync(
    path.join(dir(id), `match-${id}.title.edited.txt`),
    "One heart left | A vs B | MCSR Ranked 1v1\n",
  );
  writeFileSync(
    statusPath(id),
    JSON.stringify({
      hooksSavedAt: "2026-10-20T07:00:00Z",
      noShort: !o.short,
      steps: {},
      errors: [],
      ...(o.publishAt ? { publishAt: o.publishAt } : {}),
    }),
  );
  if (o.short) {
    // A Short already cut behind the saved hook from the current pick: the chain's next step is its upload.
    const createdAt = "2026-10-20T06:00:00Z";
    const pick = {
      gameMatchId: id,
      startMs: 300_000,
      endMs: 330_000,
      pov: "both",
      focus: "left",
      hookSuggestion: "x",
      why: "x",
      kind: "play",
      source: "agy",
      createdAt,
    };
    writeFileSync(path.join(dir(id), `short-${id}.pick.json`), JSON.stringify(pick));
    writeFileSync(path.join(dir(id), `short-${id}.hook.txt`), "Down to the last heart\n");
    writeFileSync(path.join(dir(id), `short-${id}.mp4`), "short");
    writeFileSync(
      path.join(dir(id), `short-${id}.cut.json`),
      JSON.stringify({
        ...pick,
        hook: "Down to the last heart",
        pickCreatedAt: createdAt,
        renderedAt: createdAt,
      }),
    );
  }
}
const statusOf = (id: number) => JSON.parse(readFileSync(statusPath(id), "utf8")) as Record<string, any>;

/* --- The uploader stand-in -------------------------------------------------------------------- */
const sent: Array<{ id: number; kind: string; publishAt?: string; privacyStatus: string }> = [];
/** The slotClaim on disk at the instant each long-form upload was handed over. */
const claimAtUpload = new Map<number, string | undefined>();
const videoCalls: number[] = [];
const failVideo = new Set<number>();
let gate: Promise<void> = Promise.resolve();
let now = Date.parse("2026-10-20T08:00:00Z");
const upload: Deps["upload"] = async (id, req) => {
  if (req.kind === "video") {
    claimAtUpload.set(id, flow.readStatus(id).slotClaim);
    videoCalls.push(id);
  }
  await gate;
  sent.push({ id, kind: req.kind, publishAt: req.publishAt, privacyStatus: req.privacyStatus });
  const error = req.kind === "video" && failVideo.has(id) ? "network went away" : null;
  if (!error)
    await writeUpload(
      id,
      {
        videoId: `${req.kind}-${id}`,
        uploadedAt: new Date(now).toISOString(),
        publishAt: req.publishAt ?? null,
        privacyStatus: req.privacyStatus,
        thumbnailVariant: null,
        title: "t",
      },
      req.kind,
    );
  const progress = {
    matchId: id,
    kind: req.kind,
    uploaded: 1,
    total: 1,
    done: true,
    error,
    warnings: [],
    videoId: `${req.kind}-${id}`,
  };
  return { progress, finished: Promise.resolve(progress) };
};
const deps: Partial<Deps> = {
  upload,
  render: async () => "no render expected in this test",
  pick: async () => {},
  refreshChannel: async () => {},
  resumeUpload: async () => null,
  now: () => now,
};
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `timed out waiting: ${what}`);
};
const video = (id: number) => sent.find((s) => s.id === id && s.kind === "video");
const hold = () => {
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  return () => {
    open();
    gate = Promise.resolve();
  };
};

/* --- P11, P12, P14, P15: four hooks saved inside one second (7 Oct 2026) ----------------------- */
{
  const ids = [7001, 7002, 7003, 7004];
  for (const id of ids) ready(id, { short: id === 7001 });
  // A real yield inside the claim window. Every read the claim makes is otherwise answered from
  // cache or disk without a macrotask, so the four chains would pass through it one after another
  // with or without the lock. A series of another pair, scheduled next week, makes the pair-gap
  // check ask the MCSR API about a match nobody has fetched yet — and that answer is slow.
  seats.set(7009, ["u-y", "u-z"]);
  slow.add(7009);
  mkdirSync(dir(7009), { recursive: true });
  writeFileSync(path.join(dir(7009), "series.json"), JSON.stringify({ games: [] }));
  await writeUpload(7009, {
    videoId: "video-7009",
    uploadedAt: "2026-10-19T10:00:00Z",
    publishAt: "2026-10-30T23:00:00.000Z",
    privacyStatus: "private",
    thumbnailVariant: null,
    title: "t",
  });
  const release = hold();
  const runs = ids.map((id) => flow.startChain(id, deps));
  // The window the real bug raced in: every chain has picked its slot and handed the upload over,
  // none has a youtube.json yet.
  await until(() => ids.every((id) => videoCalls.includes(id)), "all four long-form uploads begun");
  const claims = ids.map((id) => claimAtUpload.get(id));
  assert.ok(
    claims.every((c) => typeof c === "string"),
    "each chain's claim is on disk before its upload starts",
  );
  assert.equal(new Set(claims).size, 4, `four chains, four different slots: ${claims.join(", ")}`);
  for (const id of ids)
    assert.equal(
      statusOf(id).slotClaim,
      claimAtUpload.get(id),
      "the claim stays while the upload is in flight",
    );
  // A fifth match's kit, opened right now, already sees all four claims.
  ready(7005);
  assert.equal(
    (await publishSlotFor(7005, now)).at.toISOString(),
    "2026-10-24T19:00:00.000Z",
    "the 20th–23rd are spoken for by uploads still in flight",
  );
  release();
  await Promise.all(runs);

  const slots = ids.map((id) => video(id)!.publishAt!).sort();
  assert.deepEqual(
    slots,
    ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].map((d) => `${d}T19:00:00.000Z`),
    "next free 19:00 UTC each, one a day, none doubled up",
  );
  for (const id of ids) {
    assert.equal(video(id)!.privacyStatus, "private", "uploaded private, scheduled");
    assert.equal(video(id)!.publishAt, claimAtUpload.get(id), "the claimed slot is the one sent");
    assert.equal(statusOf(id).slotClaim, undefined, "the claim clears once upload-video settles done");
    assert.equal((await readUpload(id))!.publishAt, video(id)!.publishAt, "the record holds the time now");
  }
  // P12: the Short 18 h after the long-form's own time.
  const short = sent.find((s) => s.id === 7001 && s.kind === "short")!;
  assert.equal(Date.parse(short.publishAt!) - Date.parse(video(7001)!.publishAt!), 18 * 3600_000);
  assert.equal(short.privacyStatus, "private");
}

/* --- P15: a failed upload frees its slot; a restart's resume clears a lingering claim ----------- */
{
  now = Date.parse("2026-11-05T08:00:00Z");
  ready(7101);
  failVideo.add(7101);
  const release = hold();
  const run = flow.startChain(7101, deps);
  await until(() => videoCalls.includes(7101), "7101's upload begun");
  assert.equal(statusOf(7101).slotClaim, "2026-11-05T19:00:00.000Z", "claimed while it is being sent");
  release();
  await run;
  assert.equal(statusOf(7101).steps["upload-video"].state, "failed");
  assert.equal(statusOf(7101).slotClaim, undefined, "the claim clears when the step settles failed too");
  ready(7102);
  assert.equal(
    (await publishSlotFor(7102, now)).at.toISOString(),
    "2026-11-05T19:00:00.000Z",
    "the failed upload's hour is free again",
  );

  // A restart mid-upload: the step is still "running" with its claim; the resume settles it.
  for (const [id, outcome] of [
    [7103, null],
    [7104, "the upload session is gone — check Studio"],
  ] as const) {
    ready(id);
    const s = statusOf(id);
    writeFileSync(
      statusPath(id),
      JSON.stringify({
        ...s,
        slotClaim: "2026-11-06T19:00:00.000Z",
        steps: { "upload-video": { state: "running", at: "2026-11-05T07:00:00Z" } },
      }),
    );
    await flow.startChain(id, {
      ...deps,
      resumeUpload: async (mid) => {
        if (outcome === null)
          await writeUpload(mid, {
            videoId: `video-${mid}`,
            uploadedAt: "2026-11-05T07:30:00Z",
            publishAt: "2026-11-06T19:00:00.000Z",
            privacyStatus: "private",
            thumbnailVariant: null,
            title: "t",
          });
        return outcome;
      },
    });
    assert.equal(
      statusOf(id).slotClaim,
      undefined,
      `resume ${outcome === null ? "done" : "failed"}: no lingering claim`,
    );
  }
  assert.ok(
    !sent.some((x) => x.id === 7103 || x.id === 7104),
    "a resume never falls through to a second upload",
  );
}

/* --- P16: the operator's own time is sent as-is and never re-claimed ---------------------------- */
{
  now = Date.parse("2026-11-12T08:00:00Z");
  ready(7201, { publishAt: "2026-11-14T17:45:00.000Z" });
  ready(7202);
  const release = hold();
  const runs = [flow.startChain(7201, deps), flow.startChain(7202, deps)];
  await until(() => videoCalls.includes(7201) && videoCalls.includes(7202), "both begun");
  assert.equal(
    claimAtUpload.get(7201),
    undefined,
    "a chosen time writes no slotClaim — it is already a claim",
  );
  assert.equal(statusOf(7201).publishAt, "2026-11-14T17:45:00.000Z", "and the operator's time is left alone");
  release();
  await Promise.all(runs);
  assert.equal(video(7201)!.publishAt, "2026-11-14T17:45:00.000Z", "the kit's time, not a slot");
  assert.equal(video(7202)!.publishAt, "2026-11-12T19:00:00.000Z", "the other chain still gets today's slot");
}

/* --- P17: the two kinds side by side ------------------------------------------------------------ */
{
  now = Date.parse("2026-11-18T08:00:00Z");
  // Different pairs: one day, two hours — neither pushes the other a day out.
  ready(7301, { pair: ["u-q", "u-r"] });
  ready(7302, { series: true, pair: ["u-s", "u-t"] });
  await Promise.all([flow.startChain(7301, deps), flow.startChain(7302, deps)]);
  assert.equal(video(7301)!.publishAt, "2026-11-18T19:00:00.000Z", "ranked: 19:00");
  assert.equal(video(7302)!.publishAt, "2026-11-18T23:00:00.000Z", "series: 23:00 the same day");

  // The same pair: the ranked video's upload is in flight (no record yet, only its claim) when
  // the series picks — the series is held three UTC days off, and its chain says why.
  now = Date.parse("2026-11-25T08:00:00Z");
  ready(7303, { pair: ["u-u", "u-v"] });
  ready(7304, { series: true, pair: ["u-v", "u-u"] });
  const release = hold();
  const ranked = flow.startChain(7303, deps);
  await until(() => videoCalls.includes(7303), "ranked begun");
  // The kit of the series, opened now, says so beside the slot.
  const kit = await flow.publishTimeView(7304, now);
  assert.equal(kit.state, "open");
  assert.equal(kit.at, "2026-11-28T23:00:00.000Z", "the series slot in the kit is three days on");
  assert.match(kit.why ?? "", /3 days from this pair's ranked video \(2026-11-25\)/, "and says why");
  const series = flow.startChain(7304, deps);
  await until(() => videoCalls.includes(7304), "series begun");
  release();
  await Promise.all([ranked, series]);
  assert.equal(video(7303)!.publishAt, "2026-11-25T19:00:00.000Z");
  assert.equal(video(7304)!.publishAt, "2026-11-28T23:00:00.000Z");
  assert.ok(
    readShortLog(7304).some(
      (l) =>
        l.step === "chain" &&
        /^publish slot 2026-11-28T23:00:00\.000Z: pushed out to keep 3 days/.test(l.text),
    ),
    "the chain's log carries the reason",
  );
}

/* --- P13: "private" sends no time and claims none; "off" stops before any upload ---------------- */
{
  now = Date.parse("2026-12-02T08:00:00Z");
  config.nightlyUpload = "private";
  ready(7401);
  await flow.startChain(7401, deps);
  assert.deepEqual(video(7401), { id: 7401, kind: "video", publishAt: undefined, privacyStatus: "private" });
  assert.equal(claimAtUpload.get(7401), undefined, "no slot is picked, so none is claimed");
  config.nightlyUpload = "off";
  ready(7402);
  await flow.startChain(7402, deps);
  assert.equal(video(7402), undefined, "off: nothing uploads");
  assert.equal(statusOf(7402).steps["upload-video"].state, "off");
  assert.equal(statusOf(7402).slotClaim, undefined);
  config.nightlyUpload = "scheduled";
}

/* --- P18: Publish at — stored in UTC, warned not refused, an hour's lead ------------------------ */
{
  now = Date.parse("2026-12-09T08:00:00Z");
  // A live claim (a chain mid-upload) holds tonight's 19:00.
  ready(7501);
  writeFileSync(
    statusPath(7501),
    JSON.stringify({ ...statusOf(7501), slotClaim: "2026-12-09T19:00:00.000Z" }),
  );
  ready(7502);
  const clash = await flow.setPublishTime(7502, { publishAt: "2026-12-09T20:30:00+01:00" }, now);
  assert.equal(clash.status, 200, "a clash with another chain's claimed hour is saved, not refused");
  assert.equal(clash.body.publishAt, "2026-12-09T19:30:00.000Z", "stored in UTC");
  assert.equal(
    statusOf(7502).publishAt,
    "2026-12-09T19:30:00.000Z",
    "as publishAt in short-<id>.status.json",
  );
  assert.match(
    String((clash.body.warnings as string[])[0]),
    /^another video is scheduled for that hour \(2026-12-09 19:00 UTC\)/,
  );

  // The pair gap, as a warning: the same pair's ranked video is scheduled for tonight.
  ready(7503, { pair: ["u-w", "u-x"] });
  await writeUpload(7503, {
    videoId: "video-7503",
    uploadedAt: "2026-12-08T10:00:00Z",
    publishAt: "2026-12-09T19:00:00.000Z",
    privacyStatus: "private",
    thumbnailVariant: null,
    title: "t",
  });
  ready(7504, { series: true, pair: ["u-x", "u-w"] });
  const gap = await flow.setPublishTime(7504, { publishAt: "2026-12-10T23:00:00Z" }, now);
  assert.equal(gap.status, 200, "breaking the pair gap is saved, not refused");
  assert.deepEqual(gap.body.warnings, ["under 3 days from this pair's ranked video (2026-12-09)"]);
  const view = await flow.publishTimeView(7504, now);
  assert.deepEqual([view.state, view.at, view.chosen], ["open", "2026-12-10T23:00:00.000Z", true]);
  assert.deepEqual(view.warnings, gap.body.warnings, "the kit repeats the saved time's warnings");

  // Under an hour is refused (YouTube checks the time once the file is up); the docs' word is
  // "Save … refuse[s] less" than an hour, and the chain "takes it while it is an hour ahead".
  // Boundary note, not a deviation: exactly an hour ahead is refused too. Save (<=) and the chain
  // (>) agree, and a time an hour away at Save is under the hour by any upload; only the slot
  // walker's >= differs, on a 1 ms boundary nobody can hit.
  ready(7505);
  const close = await flow.setPublishTime(
    7505,
    { publishAt: new Date(now + 59 * 60_000).toISOString() },
    now,
  );
  assert.equal(close.status, 400, "59 minutes ahead is refused");
  // A stored time that has slipped under the hour by upload: the next free slot instead, said so.
  writeFileSync(
    statusPath(7505),
    JSON.stringify({ ...statusOf(7505), publishAt: new Date(now + 30 * 60_000).toISOString() }),
  );
  await flow.startChain(7505, deps);
  // Tonight's 19:00 is 7501's claim and 7503's record; 7502's own 19:30 sits in that hour too.
  assert.equal(video(7505)!.publishAt, "2026-12-10T19:00:00.000Z", "the next free slot, not the stale time");
  assert.ok(
    statusOf(7505).errors.some((e: { message: string }) =>
      /^your time .* was under an hour away — the next free slot instead/.test(e.message),
    ),
    "and the step says the operator's time stood aside",
  );
}

assert.ok(!existsSync(path.join(media, "7402", "youtube.json")), "sanity: nothing uploaded for the off case");
rmSync(media, { recursive: true, force: true });
if (ownArchive) rmSync(ownArchive, { recursive: true, force: true });
console.log("shortFlow.publishSlot.contract: all checks passed");
