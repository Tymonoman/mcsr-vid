// Contract test for the Short chain and auto-hooks (src/dashboard/shortFlow.ts), written from the
// docs by someone who had not read the code first: CLAUDE.md "Shorts" + "Auto-hooks", README "The
// Short and publishing", handbook/claude-md-reference.md "Shorts" + "Auto-hooks", and the module's
// own header. shortFlow.test.ts already pins most of the happy path through the routes; this file
// covers the promises it leaves open and walks the documented ones end to end through the module's
// exports (`saveHooks`, `startChain`, `autoHooksTick`, `setPublishTime`, `shortPlan`,
// `readStatus`, `listAutoHooks`) with the render and the uploader injected.
//
// The promises, as the docs make them:
//  C1  No Short renders and nothing uploads before the hooks are saved — a chain started on an
//      unsaved match does nothing, and half a save on disk (an edited title alone, or a Short hook
//      file alone) is not a save. (CLAUDE.md Shorts; handbook Shorts)
//  C2  Saving writes the title hook into the edited title and the Short hook into its own field,
//      `short-<id>.hook.txt`. (handbook Shorts)
//  C3  Saving both starts the chain by itself, in order: render the Short behind the saved hook,
//      upload the long-form private at its slot (next free 19:00 UTC, ranked), upload the Short
//      private 18 h after the long-form. (CLAUDE.md Shorts + nightlyUpload; README step 4)
//      Picking the slot and claiming it is one step: four saves at once get four hours. (nightlyUpload)
//  C4  The kit's Publish at: the chain's long-form takes the operator's own time while it is
//      ahead, and the Short still follows 18 h after it. (handbook Publish kit)
//  C5  `short-<id>.status.json` holds each step's state and errors: `hooksSavedAt`, each step
//      "done", no errors, the transient `slotClaim` gone once upload-video settles; a failed step
//      reads "failed" with its error, newest first in `errors`; a save is the retry and clears them.
//  C6  A Short hook changed before the Short's upload re-renders it — also after the long-form is
//      already up — and the re-cut Short is the one that uploads; the long-form is not re-sent.
//  C7  A new pick re-cuts the Short (module header); a re-save that changes nothing does not.
//  C8  After upload the hooks lock: the title once the long-form is up, the Short hook — and "no
//      Short" — once the Short is up; the same text again is accepted and uploads nothing twice —
//      also for a typed hook holding the title's own " | " (a typed hook always saves).
//  C9  "No Short for this one" lets the long-form go alone, even after a Short was rendered: the
//      Short hook file goes and no Short is uploaded.
//  C10 Uploads only while `youtubeUploadEnabled` and `nightlyUpload` allow them: with
//      `youtubeUploadEnabled` false the chain stops after the render and says Publish is the way.
//  C11 A blocked player (whole-string, case-insensitive) never gets hooks saved, so nothing starts —
//      also when only the files on disk (a saved chat) name them. (CLAUDE.md Blocked players)
//  A1  Auto-hooks is off by default (`autoHooksAfterHours` null): the tick does nothing.
//  A2  Due once the pick is at least `autoHooksAfterHours` old by its own `createdAt` — not before.
//  A3  A heuristic pick counts; with no model title hooks the chip the dashboard offers first is
//      saved (source "chip") — candidates and order are exactly `#hook`/`#shorthook`'s: the
//      model's proposals first, then the chips (an old thumbnail headline does not jump them).
//  A4  The chain then runs as if Save had been pressed: render, long-form at its slot, Short +18 h.
//  A5  Upper-cased to house style when the operator's own saved hooks read mostly upper case;
//      left as offered when they read lower case.
//  A6  Every save logged to status.json's `autoHooks`, kept across a later operator save (which
//      overwrites the hooks as usual); `listAutoHooks` then reports it no longer current.
//  A7  Not due again once saved, nor once the Short is on the channel.
//  A8  No survivor: nothing saved, the `hooks` step reads failed with "no suggested hook passed the
//      checks — save one by hand" (what Needs-you reads); a hand save clears it and the chain runs.
//
// Not reachable through the public surface: auto-hooks' "title survives, no Short hook does →
// noShort: true" needs every Short chip of a real match to fail; autoHooks.test.ts pins it on
// `autoHooksBody` instead. Where the code does not keep a promise, the assertion stays as the docs
// say and `deviation()` prints "DEVIATION: <clause> — <observed>" instead of failing the file.
// Run: npx tsx src/dashboard/shortFlow.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchInfo } from "../api/types.js";
import type { ShortPick } from "../shorts/shortPlan.js";

const roots: string[] = [];
/** A fresh, empty media dir: the auto-hooks case rule reads every past save on disk, so each case
 *  scenario gets a directory whose past hooks it controls. */
function useMedia(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-contract-"));
  roots.push(d);
  config.mediaDir = d;
  return d;
}
useMedia();
process.env.MCSR_ARCHIVE_DIR ??= path.join(roots[0]!, "archive");
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";
config.youtubePlaylistTitle = "";

// A real ranked match (edcr vs doogile). Nothing below names who won it.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const unexpected: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) return ok({ ...fixture, changes: [], id: Number(m[1]) });
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
  // Hermetic: nothing reaches the network; anything else is recorded and answered 404.
  unexpected.push(String(url));
  return new Response("not here", { status: 404 });
}) as typeof fetch;

const flow = await import("./shortFlow.js");
const { readShortHook } = await import("../shorts/shortHook.js");
const { hookRefusal } = await import("../youtube/youtubeUpload.js");
const { writeUpload } = await import("../youtube/youtubeStore.js");

/* --- Deviations: a doc promise the code does not keep is reported, not bent to the code -------- */
const deviations: string[] = [];
async function deviation(clause: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

/* --- The match on disk --------------------------------------------------------------------------- */
const NOW = Date.parse("2026-10-14T08:00:00Z");
const HOUR = 3600_000;
const dir = (id: number) => path.join(config.mediaDir, String(id));
const iso = (ms: number) => new Date(ms).toISOString();

/** Exported: a confident sync, the finished video newer than it (not stale), the pipeline's title. */
function exported(id: number): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
  );
  const final = path.join(dir(id), `final-${id}.mp4`);
  writeFileSync(final, "x");
  utimesSync(final, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  writeFileSync(path.join(dir(id), `match-${id}.title.txt`), "<HOOK> | edcr vs doogile | MCSR Ranked 1v1\n");
}
function writePick(id: number, over: Partial<ShortPick> = {}): ShortPick {
  const pick: ShortPick = {
    gameMatchId: id,
    startMs: 300_000,
    endMs: 330_000,
    pov: "both",
    focus: "left",
    hookSuggestion: "Down to the last heart",
    why: "a stand-in",
    kind: "play",
    source: "agy",
    createdAt: iso(NOW),
    ...over,
  };
  writeFileSync(path.join(dir(id), `short-${id}.pick.json`), JSON.stringify(pick));
  return pick;
}
const editedTitle = (id: number): string | null => {
  const f = path.join(dir(id), `match-${id}.title.edited.txt`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n")[0]! : null;
};
const hookFile = (id: number) => path.join(dir(id), `short-${id}.hook.txt`);

/* --- The render and the uploader, injected (ChainDeps) ------------------------------------------- */
/** Everything the chain did, in order: "render:<id>:<hook>", "video:<id>:<publishAt>", "short:<id>:<publishAt>". */
const events: string[] = [];
const of = (id: number) => events.filter((e) => e.split(":")[1] === String(id));
const render = async (id: number): Promise<string | null> => {
  const hook = await readShortHook(dir(id), id);
  if (hook === null) return "waiting for the Short's hook";
  const pick = JSON.parse(readFileSync(path.join(dir(id), `short-${id}.pick.json`), "utf8")) as ShortPick;
  writeFileSync(path.join(dir(id), `short-${id}.mp4`), "short");
  writeFileSync(
    path.join(dir(id), `short-${id}.cut.json`),
    JSON.stringify({ ...pick, hook, pickCreatedAt: pick.createdAt, renderedAt: new Date().toISOString() }),
  );
  events.push(`render:${id}:${hook}`);
  return null;
};
/** The next upload of this kind fails with this error (the Short's quota, say). */
const failNext: { video: string | null; short: string | null } = { video: null, short: null };
/** Every upload the guard let through, failed or not, with the time it asked for. */
const attempts: Array<{ id: number; kind: string; publishAt: string | null }> = [];
const upload: import("./shortFlow.js").ChainDeps["upload"] = async (id, req) => {
  // Held to the real upload guard, so the chain cannot "upload" what the real one would refuse.
  const refused = await hookRefusal(id, req.kind);
  if (refused) return refused;
  attempts.push({ id, kind: req.kind, publishAt: req.publishAt ?? null });
  const error = failNext[req.kind];
  failNext[req.kind] = null;
  const progress = {
    matchId: id,
    kind: req.kind,
    uploaded: 1,
    total: 1,
    done: true,
    error,
    warnings: [] as string[],
    videoId: error ? null : `${req.kind}-${id}`,
  };
  if (!error) {
    assert.equal(req.privacyStatus, "private", "the chain uploads private, never public");
    events.push(`${req.kind}:${id}:${req.publishAt ?? "none"}`);
    await writeUpload(
      id,
      {
        videoId: progress.videoId!,
        uploadedAt: new Date().toISOString(),
        publishAt: req.publishAt ?? null,
        privacyStatus: req.privacyStatus,
        thumbnailVariant: null,
        title: "t",
      },
      req.kind,
    );
  }
  return { progress, finished: Promise.resolve(progress) };
};
const modelAsked: number[] = [];
const deps: Partial<import("./shortFlow.js").ChainDeps> = {
  render,
  upload,
  pick: async (id) => void modelAsked.push(id),
  refreshChannel: async () => {},
  resumeUpload: async () => "unexpected resume",
  now: () => NOW,
};
flow.setPicker(async (id) => void modelAsked.push(id));

const isRefusal = (r: unknown): r is { status: number; error: string } =>
  typeof r === "object" && r !== null && "status" in r;
/** Save, as the panel's Save does, and wait for the chain that save started by itself. */
async function save(id: number, body: unknown) {
  const r = await flow.saveHooks(id, body, deps);
  await flow.chainIdle(id);
  return r;
}

try {
  /* --- C1. The gate: nothing renders or uploads before the hooks are saved ------------------------ */
  {
    const G = 14_000_001;
    exported(G);
    writePick(G);
    await flow.startChain(G, deps);
    assert.deepEqual(of(G), [], "C1: a pick and an export are not a save — nothing rendered or uploaded");
    assert.equal(flow.readStatus(G).hooksSavedAt, undefined);

    // The Title & description fold writes the edited title on its own: that is not "both hooks".
    writeFileSync(path.join(dir(G), `match-${G}.title.edited.txt`), "ONE HEART LEFT | edcr vs doogile\n");
    await flow.startChain(G, deps);
    assert.deepEqual(of(G), [], "C1: an edited title alone is half a save — no render, no upload");

    // And a Short hook file alone (no title hook) is the other half.
    rmSync(path.join(dir(G), `match-${G}.title.edited.txt`));
    writeFileSync(hookFile(G), "Down to the last heart\n");
    await flow.startChain(G, deps);
    assert.deepEqual(of(G), [], "C1: a Short hook alone is half a save — no render, no upload");
    console.log("OK: C1 nothing renders or uploads before both hooks are saved");
  }

  /* --- C2, C3, C5. Saving both: the hook files, then render → long-form → Short +18 h ------------ */
  {
    const S = 14_000_002;
    exported(S);
    writePick(S);
    const r = await save(S, { titleHook: "Who blinks first?", shortHook: "Down to the last heart" });
    assert.ok(!isRefusal(r), `C3: a clean save is accepted: ${JSON.stringify(r)}`);
    // C2: the title hook is the edited title's first half, the Short hook its own file.
    assert.match(
      editedTitle(S)!,
      /^Who blinks first\? \| edcr vs doogile/,
      "C2: the title hook leads the edited title",
    );
    assert.equal(
      readFileSync(hookFile(S), "utf8").trim(),
      "Down to the last heart",
      "C2: short-<id>.hook.txt",
    );
    // C3: the save started the chain by itself — render first, then the long-form, then the Short.
    const video = "2026-10-14T19:00:00.000Z"; // the first free 19:00 UTC after 08:00 on an empty channel
    assert.deepEqual(
      of(S),
      [`render:${S}:Down to the last heart`, `video:${S}:${video}`, `short:${S}:2026-10-15T13:00:00.000Z`],
      "C3: render → long-form at its 19:00 UTC slot → Short 18 h after it",
    );
    // C5: the status file says what each step did.
    const st = flow.readStatus(S);
    assert.ok(Number.isFinite(Date.parse(st.hooksSavedAt ?? "")), "C5: hooksSavedAt is a timestamp");
    assert.deepEqual(
      Object.fromEntries(Object.entries(st.steps).map(([k, v]) => [k, v?.state])),
      { render: "done", "upload-video": "done", "upload-short": "done" },
      "C5: each step done",
    );
    assert.deepEqual(st.errors, [], "C5: no errors on a clean run");
    assert.equal(st.slotClaim, undefined, "C5: the slot claim is cleared once upload-video settles");
    assert.equal(st.noShort, undefined);
    assert.equal((await flow.shortPlan(S, { now: NOW })).state, "scheduled");
    console.log("OK: C2 C3 C5 saving both writes the hooks and runs render → long-form → Short +18 h");
  }

  /* --- C4. The operator's own Publish at: the long-form takes it, the Short follows 18 h after --- */
  {
    const P = 14_000_003;
    exported(P);
    writePick(P);
    const set = await flow.setPublishTime(P, { publishAt: "2026-10-20T21:30:00Z" }, NOW);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    await save(P, { titleHook: "Who blinks first?", shortHook: "Down to the last heart" });
    assert.deepEqual(
      of(P).filter((e) => !e.startsWith("render")),
      [`video:${P}:2026-10-20T21:30:00.000Z`, `short:${P}:2026-10-21T15:30:00.000Z`],
      "C4: the operator's time for the long-form, the Short 18 h after it",
    );
    console.log("OK: C4 the kit's Publish at is the long-form's time and the Short's +18 h");
  }

  /* --- C5, C6, C8. A failed Short upload; its hook changed with the long-form already up --------- */
  {
    const F = 14_000_004;
    exported(F);
    writePick(F);
    failNext.short = "the daily upload quota is used up";
    await save(F, { titleHook: "Down to the wire", shortHook: "First cut" });
    const failed = flow.readStatus(F);
    assert.equal(failed.steps["upload-short"]?.state, "failed", "C5: a failed step reads failed");
    assert.equal(failed.steps["upload-short"]?.detail, "the daily upload quota is used up");
    assert.deepEqual(
      [failed.errors[0]?.step, failed.errors[0]?.message],
      ["upload-short", "the daily upload quota is used up"],
      "C5: the error, newest first",
    );
    assert.equal((await flow.shortPlan(F, { now: NOW })).state, "failed");
    const videoAt = of(F)
      .find((e) => e.startsWith("video:"))!
      .split(":")
      .slice(2)
      .join(":");

    // C8: the long-form is up, so its title hook is locked…
    const moved = await save(F, { titleHook: "Another line", shortHook: "First cut" });
    assert.ok(
      isRefusal(moved) && moved.status === 409,
      `C8: the title locks once the long-form is up: ${JSON.stringify(moved)}`,
    );
    assert.equal(editedTitle(F)!.startsWith("Down to the wire"), true, "C8: the refused save wrote nothing");

    // …but the Short is not, so its hook can still change — and the change re-cuts it (C6).
    const retry = await save(F, { titleHook: "Down to the wire", shortHook: "Second cut" });
    assert.ok(!isRefusal(retry), `C6: the Short's hook is still editable: ${JSON.stringify(retry)}`);
    assert.deepEqual(
      of(F),
      [
        `render:${F}:First cut`,
        `video:${F}:${videoAt}`,
        `render:${F}:Second cut`,
        `short:${F}:${iso(Date.parse(videoAt) + 18 * HOUR)}`,
      ],
      "C6: re-cut behind the new hook, that Short uploaded, the long-form not sent again",
    );
    assert.deepEqual(flow.readStatus(F).errors, [], "C5: a save is the retry — the old error goes");

    // C8: both up — every hook is locked, "no Short" included; the same text is fine and inert.
    for (const body of [
      { titleHook: "Down to the wire", shortHook: "Third cut" },
      { titleHook: "Down to the wire", shortHook: null, noShort: true },
      { titleHook: "Yet another", shortHook: "Second cut" },
    ]) {
      const r = await save(F, body);
      assert.ok(
        isRefusal(r) && r.status === 409,
        `C8: locked after upload: ${JSON.stringify(body)} → ${JSON.stringify(r)}`,
      );
    }
    assert.equal(
      readFileSync(hookFile(F), "utf8").trim(),
      "Second cut",
      "C8: the refused saves wrote nothing",
    );
    const before = of(F).length;
    const same = await save(F, { titleHook: "Down to the wire", shortHook: "Second cut" });
    assert.ok(!isRefusal(same), "C8: the same hooks again are accepted");
    assert.equal(of(F).length, before, "C8: and nothing is rendered or uploaded twice");
    console.log("OK: C5 C6 C8 a failed Short's hook re-cuts it after the long-form is up; uploads lock both");
  }

  /* --- C2/C8 edge: a typed title hook that holds the title's own " | " separator ------------------ */
  {
    // A typed hook always saves (CLAUDE.md: "it should just be a suggestion"), and the saved title
    // hook is what the lock compares a later save with — so the same text must read back the same.
    const SP = 14_000_010;
    exported(SP);
    writePick(SP);
    const hooks = { titleHook: "Pace | then panic", shortHook: "Down to the last heart" };
    const first = await save(SP, hooks);
    assert.ok(!isRefusal(first), JSON.stringify(first));
    assert.equal(of(SP).filter((e) => e.startsWith("video")).length, 1, "the long-form went up");
    const readBack = (await flow.shortPlan(SP, { now: NOW })).titleHook;
    assert.equal(readBack, hooks.titleHook, `the saved title hook reads back as ${JSON.stringify(readBack)}`);
    const again = await save(SP, hooks);
    assert.ok(!isRefusal(again), `re-saving the very same hooks answered ${JSON.stringify(again)}`);
    console.log("OK: C2 C8 a typed title hook holding \" | \" reads back whole; the same save again is accepted");
  }

  /* --- C9. No Short for this one, after a Short was already rendered ------------------------------ */
  {
    const N = 14_000_005;
    exported(N);
    writePick(N);
    config.nightlyUpload = "off";
    await save(N, { titleHook: "Who blinks first?", shortHook: "Cut, then dropped" });
    assert.deepEqual(of(N), [`render:${N}:Cut, then dropped`], "rendered; uploads are off");
    config.nightlyUpload = "scheduled";
    const r = await save(N, { titleHook: "Who blinks first?", shortHook: null, noShort: true });
    assert.ok(!isRefusal(r), JSON.stringify(r));
    assert.ok(!existsSync(hookFile(N)), "C9: no Short, no hook file");
    assert.equal(flow.readStatus(N).noShort, true);
    assert.deepEqual(
      of(N).map((e) => e.split(":")[0]),
      ["render", "video"],
      "C9: the long-form went alone — the Short already cut never uploads",
    );
    const p = await flow.shortPlan(N, { now: NOW });
    assert.equal(p.state, "scheduled");
    assert.match(p.detail ?? "", /no Short/);
    console.log("OK: C9 no Short for this one, even after a Short was cut");
  }

  /* --- C10, C7. youtubeUploadEnabled off: stops after the render; a new pick re-cuts -------------- */
  {
    const U = 14_000_006;
    exported(U);
    writePick(U);
    config.youtubeUploadEnabled = false;
    await save(U, { titleHook: "Who blinks first?", shortHook: "Uploads are off" });
    assert.deepEqual(of(U), [`render:${U}:Uploads are off`], "C10: rendered, nothing uploaded");
    assert.equal(flow.readStatus(U).steps["upload-video"]?.state, "off", "C10: the upload step says off");
    const p = await flow.shortPlan(U, { now: NOW });
    assert.equal(p.state, "failed");
    assert.match(p.detail ?? "", /uploads are off/, "C10: … and that Publish is the way");

    // C7: a re-save that changes nothing keeps the Short on disk…
    await save(U, { titleHook: "Who blinks first?", shortHook: "Uploads are off" });
    assert.equal(of(U).length, 1, "C7: an unchanged re-save does not re-cut");
    // …a new pick (Pick again) re-cuts it.
    writePick(U, { startMs: 400_000, endMs: 430_000, createdAt: iso(NOW + 60_000) });
    await save(U, { titleHook: "Who blinks first?", shortHook: "Uploads are off" });
    assert.deepEqual(
      of(U),
      [`render:${U}:Uploads are off`, `render:${U}:Uploads are off`],
      "C7: a new pick re-cuts",
    );
    config.youtubeUploadEnabled = true;
    console.log("OK: C10 C7 uploads off stops after the render; a new pick re-cuts the Short");
  }

  /* --- C11. A blocked player, spelled in another case: no hooks, nothing starts ------------------- */
  {
    const B = 14_000_007;
    exported(B);
    writePick(B);
    const kept = config.blockedPlayers;
    config.blockedPlayers = ["EDCR"]; // the fixture's left player, in capitals
    const r = await save(B, { titleHook: "Who blinks first?", shortHook: "Down to the last heart" });
    config.blockedPlayers = kept;
    assert.ok(isRefusal(r) && r.status === 403, `C11: refused: ${JSON.stringify(r)}`);
    assert.equal(editedTitle(B), null, "C11: no title written");
    assert.ok(!existsSync(hookFile(B)), "C11: no Short hook written");
    assert.equal(flow.readStatus(B).hooksSavedAt, undefined);
    assert.deepEqual(of(B), [], "C11: nothing rendered or uploaded");
    console.log("OK: C11 a blocked player (any case) never gets hooks saved");

    // The block list is checked against the files on disk too — clips, saved chats and the
    // title's pair — "so a match archived off disk is still caught", and a blocked match "never
    // gets hooks saved". Here the API's names are clean, but the saved chat names a blocked
    // runner (a rename since the chat was fetched; the name is made up).
    const D = 14_000_009;
    exported(D);
    writePick(D);
    writeFileSync(path.join(dir(D), "chat-Renamedrunner.json"), "[]");
    config.blockedPlayers = ["Renamedrunner"];
    const rd = await save(D, { titleHook: "Who blinks first?", shortHook: "Down to the last heart" });
    config.blockedPlayers = kept;
    // CLAUDE.md Blocked players: a blocked match (per the disk check) never gets hooks saved.
    assert.ok(isRefusal(rd) && rd.status === 403, `saveHooks answered ${JSON.stringify(rd)}`);
    // Whatever the save did, the upload guard's disk check must still keep it off the channel.
    assert.ok(!of(D).some((e) => e.startsWith("video") || e.startsWith("short")), "C11: never uploaded");
  }

  /* --- C3/C5. Four hooks saved inside one second get four slots; a failed upload frees its slot --- */
  {
    useMedia();
    const four = [14_000_011, 14_000_012, 14_000_013, 14_000_014];
    for (const id of four) {
      exported(id);
      writePick(id);
    }
    // 7 Oct 2026: four saves in one second once put three long-forms on the same 19:00 UTC hour.
    await Promise.all(
      four.map((id) =>
        flow.saveHooks(id, { titleHook: "Who blinks first?", shortHook: null, noShort: true }, deps),
      ),
    );
    await Promise.all(four.map((id) => flow.chainIdle(id)));
    const slots = four.map((id) =>
      of(id)
        .find((e) => e.startsWith("video:"))
        ?.split(":")
        .slice(2)
        .join(":"),
    );
    assert.ok(
      slots.every((s) => s !== undefined && /T19:00:00\.000Z$/.test(s)),
      `C3: four 19:00 UTC slots: ${slots}`,
    );
    assert.equal(new Set(slots).size, 4, `C3: concurrent chains never collide on an hour: ${slots}`);
    for (const id of four) assert.equal(flow.readStatus(id).slotClaim, undefined, "C5: every claim cleared");

    // A failed long-form upload: the step fails, its claim goes with it, and the hour it asked for
    // is free for the next chain ("the claim clears once the upload-video step settles, done or failed").
    const FV = 14_000_015;
    const NX = 14_000_016;
    exported(FV);
    writePick(FV);
    failNext.video = "the connection was reset";
    await save(FV, { titleHook: "Who blinks first?", shortHook: null, noShort: true });
    const fst = flow.readStatus(FV);
    assert.equal(fst.steps["upload-video"]?.state, "failed");
    assert.equal(fst.slotClaim, undefined, "C5: a failed upload leaves no claim behind");
    const asked = attempts.find((a) => a.id === FV && a.kind === "video")!.publishAt;
    exported(NX);
    writePick(NX);
    await save(NX, { titleHook: "Who blinks first?", shortHook: null, noShort: true });
    assert.deepEqual(
      of(NX),
      [`video:${NX}:${asked}`],
      "C5: the next chain takes the hour the failed one let go",
    );
    console.log("OK: C3 C5 four saves at once get four slots; a failed upload frees its hour");
  }

  /* --- A1. Auto-hooks is off by default, however old the pick ------------------------------------- */
  {
    assert.equal(config.autoHooksAfterHours, null, "A1: the default is null = off");
    const O = 14_000_008;
    exported(O);
    writePick(O, { createdAt: iso(NOW - 100 * HOUR) });
    await flow.autoHooksTick(deps, NOW);
    assert.equal(flow.readStatus(O).hooksSavedAt, undefined, "A1: off saves nothing");
    assert.equal(flow.readStatus(O).autoHooks, undefined);
    assert.deepEqual(of(O), []);
    console.log("OK: A1 auto-hooks is off by default");
  }

  /* --- A2, A3, A4, A7. Due by the pick's age; a heuristic pick; the chain as if Save were pressed - */
  useMedia(); // no past saved hooks here: the case is left as offered
  config.autoHooksAfterHours = 6;
  {
    const early = 14_000_101;
    const due = 14_000_102;
    exported(early);
    writePick(early, { createdAt: iso(NOW - 6 * HOUR + 60_000) });
    exported(due);
    // The heuristic's pick: no title hooks of the model's, so the title must come from a chip.
    const pick = writePick(due, { source: "heuristic", createdAt: iso(NOW - 6 * HOUR) });
    const offered = (await flow.shortPlan(due, { now: NOW })).suggestions;
    assert.ok(
      offered.title.length > 0 && offered.short.length > 0,
      "the dashboard offers chips for a real match",
    );

    await flow.autoHooksTick(deps, NOW);
    await flow.chainIdle(due);
    assert.equal(flow.readStatus(early).hooksSavedAt, undefined, "A2: a minute short of 6 h is not due");
    const st = flow.readStatus(due);
    assert.ok(st.hooksSavedAt, "A2/A3: exactly 6 h old, and a heuristic pick counts");
    assert.deepEqual(
      st.autoHooks && {
        title: st.autoHooks.titleHook,
        short: st.autoHooks.shortHook,
        source: st.autoHooks.source,
      },
      {
        title: offered.title[0],
        short: offered.short[0],
        source: { title: "chip", short: offered.short[0] === pick.hookSuggestion ? "model" : "chip" },
      },
      "A3: the first hooks the dashboard offers, the title from a chip",
    );
    assert.equal(
      editedTitle(due)!.split(" | ")[0],
      offered.title[0],
      "A3: saved exactly as the panel's Save would",
    );
    assert.equal(readFileSync(hookFile(due), "utf8").trim(), offered.short[0]);
    const v = of(due)
      .find((e) => e.startsWith("video:"))!
      .split(":")
      .slice(2)
      .join(":");
    assert.deepEqual(
      of(due),
      [
        `render:${due}:${offered.short[0]}`,
        `video:${due}:2026-10-14T19:00:00.000Z`,
        `short:${due}:${iso(Date.parse(v) + 18 * HOUR)}`,
      ],
      "A4: the chain ran as if Save had been pressed",
    );

    // A7: a later tick finds it saved and leaves it — the record and the uploads stand.
    const at = st.autoHooks!.at;
    await flow.autoHooksTick(deps, NOW + HOUR);
    assert.equal(flow.readStatus(due).autoHooks?.at, at, "A7: not saved twice");
    assert.equal(of(due).length, 3, "A7: nothing re-rendered or re-uploaded");

    // A2: the early one becomes due by its own age, a minute later.
    await flow.autoHooksTick(deps, NOW + 60_000);
    await flow.chainIdle(early);
    assert.ok(flow.readStatus(early).hooksSavedAt, "A2: due once the pick is 6 h old");

    // A7: a Short already on the channel (an upload record) means the match is not due.
    const onChannel = 14_000_103;
    exported(onChannel);
    writePick(onChannel, { createdAt: iso(NOW - 7 * HOUR) });
    await writeUpload(
      onChannel,
      {
        videoId: "short-x",
        uploadedAt: iso(NOW),
        publishAt: null,
        privacyStatus: "private",
        thumbnailVariant: null,
        title: "t",
      },
      "short",
    );
    await flow.autoHooksTick(deps, NOW);
    assert.equal(flow.readStatus(onChannel).hooksSavedAt, undefined, "A7: the Short on the channel: not due");
    console.log("OK: A2 A3 A4 A7 due by the pick's own age; the first offered hooks; the chain runs");
  }

  /* --- A5. Upper-cased when the operator's own saved hooks are; as offered when they are not ------ */
  /** Past uploads with the operator's own saved title hooks: what `pastTitleHooks` reads. */
  const pastSaves = (ids: number[], hooks: string[]) =>
    ids.forEach((id, i) => {
      mkdirSync(dir(id), { recursive: true });
      writeFileSync(path.join(dir(id), "youtube.json"), JSON.stringify({ videoId: `old-${id}` }));
      writeFileSync(
        path.join(dir(id), `match-${id}.title.edited.txt`),
        `${hooks[i]} | edcr vs doogile | MCSR Ranked 1v1\n`,
      );
    });
  {
    useMedia();
    pastSaves(
      [14_000_201, 14_000_202, 14_000_203],
      ["58 MILLISECONDS", "NOT A SINGLE DEATH", "WHO BLINKS FIRST?"],
    );
    const UP = 14_000_204;
    exported(UP);
    writePick(UP, { titleHooks: ["One heart left"], createdAt: iso(NOW - 7 * HOUR) });
    await flow.autoHooksTick(deps, NOW);
    await flow.chainIdle(UP);
    assert.equal(
      editedTitle(UP)?.split(" | ")[0],
      "ONE HEART LEFT",
      "A5: the title hook in the house's upper case",
    );
    assert.equal(
      readFileSync(hookFile(UP), "utf8").trim(),
      "DOWN TO THE LAST HEART",
      "A5: the Short hook too",
    );
    assert.deepEqual(
      flow.readStatus(UP).autoHooks?.source,
      { title: "model", short: "model" },
      "the model's own, first",
    );
    console.log("OK: A5 auto-hooks match the operator's upper-case house style");
  }

  /* --- A5, A6. Lower-case house style; a later operator save overwrites, the record stays --------- */
  {
    useMedia();
    pastSaves(
      [14_000_301, 14_000_302, 14_000_303],
      ["A quiet finish", "Not a single death", "Who blinks first?"],
    );
    const LO = 14_000_304;
    exported(LO);
    writePick(LO, { titleHooks: ["One heart left"], createdAt: iso(NOW - 7 * HOUR) });
    config.nightlyUpload = "off"; // nothing goes up, so the hooks stay editable
    await flow.autoHooksTick(deps, NOW);
    await flow.chainIdle(LO);
    assert.equal(
      editedTitle(LO)?.split(" | ")[0],
      "One heart left",
      "A5: left as offered when the house is not upper case",
    );
    assert.equal(readFileSync(hookFile(LO), "utf8").trim(), "Down to the last heart");
    const record = flow.readStatus(LO).autoHooks;
    assert.ok(record, "A6: the save is logged in status.json's autoHooks");

    const r = await save(LO, { titleHook: "Who keeps the pace?", shortHook: "Typed by hand" });
    assert.ok(!isRefusal(r), JSON.stringify(r));
    assert.equal(
      editedTitle(LO)?.split(" | ")[0],
      "Who keeps the pace?",
      "A6: the operator's save overwrites the hooks",
    );
    assert.deepEqual(flow.readStatus(LO).autoHooks, record, "A6: the autoHooks record is kept across it");
    const row = (await flow.listAutoHooks(Date.now() - HOUR, Date.now() + HOUR)).find(
      (x) => x.matchId === LO,
    );
    assert.ok(row, "A6: the morning report's list still has it");
    assert.equal(row!.titleHook, "One heart left");
    assert.equal(row!.stillCurrent, false, "A6: … and says the operator has changed it since");
    config.nightlyUpload = "scheduled";
    console.log("OK: A5 A6 lower-case house style kept; an operator save overwrites, the record stays");
  }

  /* --- A3 edge: an old thumbnail headline on disk does not outrank the model's own proposal ------ */
  {
    // Thumbnails carried a headline until 18 Sept 2026 and a re-render keeps it (carriedHookText).
    // The docs give auto-hooks one order — "the model's proposals first, then the chips" — and
    // record where the hook came from as "model" or "chip".
    useMedia();
    const OLD = 14_000_501;
    exported(OLD);
    writePick(OLD, { titleHooks: ["One heart left"], createdAt: iso(NOW - 7 * HOUR) });
    const { manifestPath } = await import("../thumbnails/thumbnailVariants.js");
    writeFileSync(manifestPath(dir(OLD)), JSON.stringify({ variants: [], hookText: "Every second counts" }));
    config.nightlyUpload = "off";
    await flow.autoHooksTick(deps, NOW);
    await flow.chainIdle(OLD);
    config.nightlyUpload = "scheduled";
    const a = flow.readStatus(OLD).autoHooks;
    assert.ok(a, "saved: the pick is due and clean candidates exist");
    await deviation("handbook Auto-hooks: the model's proposals first, then the chips", () => {
      assert.deepEqual(
        [a!.titleHook, a!.source.title],
        ["One heart left", "model"],
        `auto-hooks saved ${JSON.stringify(a!.titleHook)} (source "${a!.source.title}")`,
      );
    });
  }

  /* --- A8. No candidate survives: the hooks step fails; a hand save clears it ------------------- */
  {
    useMedia();
    const X = 14_000_401;
    exported(X);
    writePick(X, { titleHooks: ["One heart left"], createdAt: iso(NOW - 7 * HOUR) });
    // Both names spelled long enough to leave the title no room for any hook — the same budget
    // the dashboard's own chips are held to, so nothing can pass.
    const kept = config.titleNames;
    config.titleNames = { edcr: "E".repeat(30), doogile: "D".repeat(30) };
    await flow.autoHooksTick(deps, NOW);
    config.titleNames = kept;
    const st = flow.readStatus(X);
    assert.equal(st.hooksSavedAt, undefined, "A8: nothing saved");
    assert.equal(editedTitle(X), null, "A8: no title written");
    assert.ok(!existsSync(hookFile(X)), "A8: no Short hook written");
    assert.equal(st.steps.hooks?.state, "failed", "A8: the hooks step reads failed — what Needs-you lists");
    assert.equal(st.errors[0]?.message, "auto-hooks: no suggested hook passed the checks — save one by hand");
    assert.deepEqual(of(X), [], "A8: nothing rendered or uploaded");

    const r = await save(X, { titleHook: "Who blinks first?", shortHook: "By hand, at last" });
    assert.ok(!isRefusal(r), JSON.stringify(r));
    const after = flow.readStatus(X);
    assert.equal(after.steps.hooks, undefined, "A8: the hand save clears the failed hooks step");
    assert.equal(
      after.errors.some((e) => e.step === "hooks"),
      false,
    );
    assert.equal(of(X)[0], `render:${X}:By hand, at last`, "A8: and the chain runs");
    console.log("OK: A8 no survivor fails the hooks step; a hand save clears it and the chain runs");
  }

  /* --- A9. A runner blocked on disk only (a rename; the API's pair is clean): skipped, not failed -- */
  {
    useMedia();
    const R = 14_000_601;
    exported(R);
    writePick(R, { titleHooks: ["One heart left"], createdAt: iso(NOW - 7 * HOUR) });
    writeFileSync(path.join(dir(R), "chat-Renamedrunner.json"), "[]");
    const kept = config.blockedPlayers;
    config.blockedPlayers = ["Renamedrunner"];
    await flow.autoHooksTick(deps, NOW);
    await flow.chainIdle(R);
    config.blockedPlayers = kept;
    const st = flow.readStatus(R);
    assert.equal(st.hooksSavedAt, undefined, "A9: nothing saved");
    assert.equal(st.autoHooks, undefined, "A9: no auto-hooks record");
    assert.equal(st.steps.hooks, undefined, "A9: no failed hooks step — a blocked match never reaches Needs-you");
    assert.deepEqual(of(R), [], "A9: nothing rendered or uploaded");
    console.log("OK: A9 auto-hooks skips a match its own files block");
  }

  assert.deepEqual(modelAsked, [], "every match had a pick: the model is never asked");
  assert.deepEqual(unexpected, [], "no request left the MCSR API stand-in");
  if (deviations.length) console.log(`${deviations.length} deviation(s) from the docs — see DEVIATION lines`);
  console.log("shortFlow.contract: all checks passed");
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
