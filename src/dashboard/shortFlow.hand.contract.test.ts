// Contract test for the publish chain in hand mode (`shortsByHand`), written from the docs alone
// (CLAUDE.md "Shorts" → shortsByHand; README step 3; handbook/claude-md-reference.md "Shorts",
// first bullet). The full numbered promise list is at the top of
// src/shorts/handShort.contract.test.ts; this file holds the chain's half:
//
//  P5  (contrast) The operator's own typed hook on the dashboard only warns and saves — the hand
//      CLI is the one that refuses outright.
//  P12 On, the chain skips its own pick/render step for the Short; the long-form uploads at its
//      slot without waiting on either.
//  P13 Until the pair (short-<id>.mp4 + short-<id>.hand.json) exists the chain logs "waiting for
//      the hand-made Short" and touches no step's state — never a failure, no Needs-you noise.
//      Half a pair (a leftover model cut, a hand.json without its mp4, a corrupt hand.json) is
//      still "not yet".
//  P14 The pick after export still runs (`ensurePick`) — auto-hooks needs its title hooks.
//  P15 `noShort` still means no Short, hand-cut or not.
//  P16 A blocked player still means no Short, hand-cut or not.
//  P17 The Short's publish time is still `shortPublishAt`: 18 h after the long-form.
//  P18 Off is today's pick → render → upload chain — the setting alone decides, never a leftover
//      hand.json.
//
// Driven through the exported surface (`saveHooks`, `startChain`/`chainIdle`, `shortTick`,
// `ensurePick`, `setPicker`, `nightlyShortSummary`, `readStatus`, `shortPublishAt`). The model,
// the render and the uploader are stand-ins; the uploader goes through the real upload guard
// (`hookRefusal`) so the chain is held to the rules a real upload is. The MCSR API is a stubbed
// global fetch serving a real fixture with renamed players; nothing reaches YouTube.
// Run: npx tsx src/dashboard/shortFlow.hand.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import type { ShortPick } from "../shorts/shortPlan.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-hand-contract-"));
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = path.join(media, "archive");
config.youtubeUploadEnabled = true;
config.nightlyUpload = "scheduled";
config.youtubePlaylistTitle = "";
config.blockedPlayers = ["SomeoneElse"];
config.autoHooksAfterHours = null;

const LEFT = "RunnerAlpha";
const RIGHT = "RunnerBravo";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const matchOf = (id: number): MatchInfo => ({
  ...fixture,
  id,
  changes: [],
  players: fixture.players.map((p, i) => ({ ...p, nickname: i === 0 ? LEFT : RIGHT })),
});
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m)
    return new Response(JSON.stringify({ status: "success", data: matchOf(Number(m[1])) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const flow = await import("./shortFlow.js");
const { hookRefusal } = await import("../youtube/youtubeUpload.js");
const { writeUpload, readUpload } = await import("../youtube/youtubeStore.js");
const { readShortLog } = await import("../shorts/shortLog.js");

const dir = (id: number) => path.join(media, String(id));
const file = (id: number, suffix: string) => path.join(dir(id), `short-${id}${suffix}`);
/** An exported match: a confident sync, then the finished video, and the pipeline's own title. */
function exported(id: number): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
  );
  const final = path.join(dir(id), `final-${id}.mp4`);
  writeFileSync(final, "x");
  // Newer than sync.json, as an export always is (an older one is a stale export).
  utimesSync(final, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
  writeFileSync(
    path.join(dir(id), `match-${id}.title.txt`),
    `<HOOK> | ${LEFT} vs ${RIGHT} | MCSR Ranked 1v1\n`,
  );
}
const pickOf = (id: number): ShortPick => ({
  gameMatchId: id,
  startMs: 300_000,
  endMs: 330_000,
  pov: "both",
  focus: "left",
  hookSuggestion: "ONE PEARL FROM THE END",
  why: "a stand-in",
  kind: "play",
  source: "agy",
  createdAt: new Date().toISOString(),
});
/** What `npm run short:hand` leaves (handShort.contract.test.ts pins how it gets there). */
function handPair(id: number, parts: { mp4?: boolean; hand?: string } = {}): void {
  if (parts.mp4 !== false) writeFileSync(file(id, ".mp4"), "hand-cut-bytes");
  if (parts.hand !== "")
    writeFileSync(
      file(id, ".hand.json"),
      parts.hand ??
        JSON.stringify({
          hook: "ONE PEARL FROM THE END",
          builtAt: "2026-10-14T09:00:00Z",
          windowMatchSec: [300, 330],
          pov: "left",
        }),
    );
  writeFileSync(file(id, ".title.txt"), `ONE PEARL FROM THE END | ${LEFT} vs ${RIGHT} #mcsr #minecraft\n`);
  writeFileSync(file(id, ".description.txt"), `${LEFT} vs ${RIGHT}, mcsr ranked 1v1.\n#mcsr #minecraft\n`);
}

// The model and the render: recorded, writing what the real ones write.
const picks: number[] = [];
const picker: import("./shortFlow.js").Picker = async (id) => {
  picks.push(id);
  writeFileSync(file(id, ".pick.json"), JSON.stringify(pickOf(id)));
};
flow.setPicker(picker);
const renders: number[] = [];
const render = async (id: number): Promise<string | null> => {
  renders.push(id);
  const hook = readFileSync(file(id, ".hook.txt"), "utf8").trim();
  const pick = JSON.parse(readFileSync(file(id, ".pick.json"), "utf8")) as ShortPick;
  writeFileSync(file(id, ".mp4"), "model-cut");
  writeFileSync(file(id, ".title.txt"), `${hook} | ${LEFT} vs ${RIGHT} #mcsr #minecraft\n`);
  writeFileSync(file(id, ".cut.json"), JSON.stringify({ ...pick, hook, pickCreatedAt: pick.createdAt }));
  return null;
};
// The uploader: the real guard first, then the record beginUpload would write.
const sent: Array<{ id: number; kind: string; publishAt?: string }> = [];
const upload: import("./shortFlow.js").ChainDeps["upload"] = async (id, req) => {
  const refused = await hookRefusal(id, req.kind);
  if (refused) return refused;
  sent.push({ id, kind: req.kind, publishAt: req.publishAt });
  const progress = {
    matchId: id,
    kind: req.kind,
    uploaded: 1,
    total: 1,
    done: true,
    error: null,
    warnings: [],
    videoId: `${req.kind}-${id}`,
  };
  await writeUpload(
    id,
    {
      videoId: progress.videoId,
      uploadedAt: new Date(NOW).toISOString(),
      publishAt: req.publishAt ?? null,
      privacyStatus: req.privacyStatus,
      thumbnailVariant: null,
      title: "t",
    },
    req.kind,
  );
  return { progress, finished: Promise.resolve(progress) };
};
const NOW = Date.parse("2026-10-14T08:00:00Z");
const chain = {
  render,
  upload,
  pick: async (id: number) => {
    await picker(id, { force: false });
  },
  refreshChannel: async () => {},
  resumeUpload: async () => null,
  now: () => NOW,
};
async function save(id: number, body: unknown) {
  const result = await flow.saveHooks(id, body, chain);
  await flow.chainIdle(id);
  return result;
}
async function tick(...ids: number[]) {
  await flow.shortTick(chain, NOW);
  for (const id of ids) await flow.chainIdle(id);
}
const sentOf = (id: number, kind: "video" | "short") => sent.filter((s) => s.id === id && s.kind === kind);
const waitingLogged = (id: number) =>
  readShortLog(id).some((l) => l.step === "chain" && /waiting for the hand-made Short/.test(l.text));

let nextId = 92_000_001;
const fresh = (): number => {
  const id = nextId++;
  exported(id);
  return id;
};

try {
  config.shortsByHand = true;

  /* --- P12/P13/P5: save with no pick, no Short yet --------------------------------------------- */
  {
    const id = fresh();
    // The Short hook typed on the dashboard is a label: P5's contrast — the typed hook only warns
    // and saves (the operator's rule, "it should just be a suggestion"); handShort refuses it.
    const result = await save(id, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "WIZARD vs BUILDER" });
    assert.ok(
      result && !("status" in result),
      `P5: a typed label hook saves (got ${JSON.stringify(result)})`,
    );
    assert.ok(
      result.saveWarnings?.some((w) => /label/.test(w)),
      "P5: … with the label as a warning, not a refusal",
    );
    // P12: no pick and no render — and nothing recorded for either step either.
    assert.deepEqual(picks, [], "P12: the chain queued no model pick");
    assert.deepEqual(renders, [], "P12: the chain rendered nothing");
    const steps = flow.readStatus(id).steps;
    assert.equal(steps.pick, undefined, "P12: no pick step recorded");
    assert.equal(steps.render, undefined, "P12: no render step recorded");
    // P12: the long-form went up at its scheduled slot without waiting on the Short.
    const [video] = sentOf(id, "video");
    assert.ok(
      video?.publishAt && Date.parse(video.publishAt) > NOW,
      "P12: the long-form uploaded, scheduled",
    );
    assert.deepEqual(sentOf(id, "short"), []);
    // P13: one log line saying so, and no step touched — upload-video is the only step there is.
    assert.ok(waitingLogged(id), 'P13: the chain logged "waiting for the hand-made Short"');
    assert.deepEqual(Object.keys(steps), ["upload-video"], "P13: no step's state for the Short");
    assert.equal(steps["upload-video"]?.state, "done");
    assert.deepEqual(flow.readStatus(id).errors, [], "P13: no error recorded");
    // P13: never a failure — not on the nightly strip's "failed", not "failed" on the list.
    const summary = await flow.nightlyShortSummary();
    assert.ok(!summary.failed.includes(id), "P13: not among the failed (no Needs-you noise)");
    assert.notEqual((await flow.matchRowShort(id)).shortState, "failed");

    // A tick with nothing landed yet is a quiet no-op: still nothing sent, still nothing failed.
    await tick(id);
    assert.deepEqual(sentOf(id, "short"), []);
    assert.equal(
      flow.readStatus(id).steps["upload-short"],
      undefined,
      "P13: a tick while waiting touches nothing",
    );

    // P17: once the pair lands, the tick sends it 18 h after the long-form.
    handPair(id);
    await tick(id);
    const [short] = sentOf(id, "short");
    assert.ok(short, "P13: the tick noticed the pair and uploaded the Short");
    assert.equal(
      short.publishAt,
      new Date(Date.parse(video!.publishAt!) + 18 * 3600_000).toISOString(),
      "P17: the Short goes public 18 h after the long-form",
    );
    console.log("OK: P12/P13/P17 — long-form alone, a quiet wait, then the Short 18 h later");
  }

  /* --- P13: half a pair is not a pair ----------------------------------------------------------- */
  {
    // A leftover model cut from before hand mode was switched on: mp4 + cut.json, behind the saved
    // hook and the current pick — the chain must not upload a model Short in hand mode.
    const leftover = fresh();
    writeFileSync(file(leftover, ".pick.json"), JSON.stringify(pickOf(leftover)));
    const pick = JSON.parse(readFileSync(file(leftover, ".pick.json"), "utf8")) as ShortPick;
    writeFileSync(file(leftover, ".mp4"), "model-cut");
    writeFileSync(
      file(leftover, ".cut.json"),
      JSON.stringify({ ...pick, hook: "ONE PEARL FROM THE END", pickCreatedAt: pick.createdAt }),
    );
    writeFileSync(
      file(leftover, ".title.txt"),
      `ONE PEARL FROM THE END | ${LEFT} vs ${RIGHT} #mcsr #minecraft\n`,
    );
    await save(leftover, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });

    // hand.json without its mp4.
    const noMp4 = fresh();
    handPair(noMp4, { mp4: false });
    await save(noMp4, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });

    // A hand.json cut off mid-write beside its mp4: read as "none yet", never a crash.
    const corrupt = fresh();
    handPair(corrupt, { hand: '{"hook": "ONE PEA' });
    await save(corrupt, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });

    await tick(leftover, noMp4, corrupt);
    for (const [id, what] of [
      [leftover, "a leftover model cut"],
      [noMp4, "a hand.json with no mp4"],
      [corrupt, "a corrupt hand.json"],
    ] as const) {
      assert.equal(sentOf(id, "video").length, 1, `${what}: the long-form still went up alone`);
      assert.deepEqual(sentOf(id, "short"), [], `P13: ${what} is not a hand-cut Short — nothing uploaded`);
      assert.ok(waitingLogged(id), `P13: ${what} — "waiting for the hand-made Short"`);
      assert.equal(flow.readStatus(id).steps["upload-short"], undefined, `P13: ${what} — no failed step`);
    }
    console.log("OK: P13 — half a pair (model cut, missing mp4, corrupt hand.json) keeps waiting, quietly");
  }

  /* --- P17: the pair already there when the hooks are saved -------------------------------------- */
  {
    const id = fresh();
    handPair(id);
    await save(id, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });
    const [video] = sentOf(id, "video");
    const [short] = sentOf(id, "short");
    assert.ok(video && short, "both go up in one pass when the session cut the Short first");
    assert.equal(
      short.publishAt,
      flow
        .shortPublishAt(
          { videoId: `video-${id}`, publishAt: video.publishAt!, privacyStatus: "private" },
          NOW,
        )!
        .toISOString(),
      "P17: shortPublishAt, unchanged",
    );
    assert.ok(!waitingLogged(id), "nothing to wait for");
    console.log("OK: P17 — a Short cut before Save goes up in the same pass, 18 h after the long-form");
  }

  /* --- P14: the pick after export still runs ------------------------------------------------------ */
  {
    const id = fresh();
    picks.length = 0;
    const queued = flow.ensurePick(id);
    assert.ok(queued, "P14: ensurePick queues a pick in hand mode");
    await queued;
    assert.deepEqual(picks, [id], "P14: the model was asked");
    // … but not for a match the operator said gets no Short — nothing would use its window or
    // its hooks' Short half. (`noShort` recorded in short-<id>.status.json, as Save writes it.)
    const none = fresh();
    writeFileSync(file(none, ".status.json"), JSON.stringify({ noShort: true, steps: {}, errors: [] }));
    assert.equal(flow.ensurePick(none), null, "no pick for a noShort match");
    console.log("OK: P14 — ensurePick still picks after export in hand mode");
  }

  /* --- P15: noShort means no Short, hand-cut or not ----------------------------------------------- */
  {
    const id = fresh();
    handPair(id); // the session cut one anyway
    const result = await save(id, { titleHook: "DOWN TO THE LAST PEARL", shortHook: null, noShort: true });
    assert.ok(!result || !("status" in result), JSON.stringify(result));
    await tick(id);
    await tick(id);
    assert.equal(sentOf(id, "video").length, 1, "P15: the long-form goes alone");
    assert.deepEqual(sentOf(id, "short"), [], "P15: the hand-cut Short of a noShort match never goes up");
    const row = await flow.matchRowShort(id);
    assert.match(row.shortDetail ?? "", /no Short/, "P15: the list says no Short");
    console.log("OK: P15 — noShort holds against a hand-cut Short on disk (chain and tick)");
  }

  /* --- P16: a blocked player means no Short, hand-cut or not -------------------------------------- */
  {
    // Blocked before Save: no hooks, no chain.
    const before = config.blockedPlayers;
    const early = fresh();
    handPair(early);
    config.blockedPlayers = [RIGHT];
    try {
      const refused = await save(early, {
        titleHook: "DOWN TO THE LAST PEARL",
        shortHook: "ONE PEARL FROM THE END",
      });
      assert.equal(refused && "status" in refused ? refused.status : null, 403, "P16: hooks are refused");
      assert.deepEqual(sentOf(early, "video"), []);
      assert.deepEqual(sentOf(early, "short"), [], "P16: nothing of a blocked match goes up");
    } finally {
      config.blockedPlayers = before;
    }
    // Blocked after the long-form went up (a runner withdrew permission that day): the pair lands,
    // the tick runs the chain — and the Short still never reaches the channel.
    const late = fresh();
    await save(late, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });
    assert.equal(sentOf(late, "video").length, 1);
    handPair(late);
    config.blockedPlayers = [LEFT.toLowerCase()];
    try {
      await tick(late);
      assert.deepEqual(
        sentOf(late, "short"),
        [],
        "P16: a hand-cut Short of a now-blocked runner never goes up",
      );
      assert.equal(await readUpload(late, "short"), null);
    } finally {
      config.blockedPlayers = before;
    }
    console.log("OK: P16 — a blocked player stops the hand-cut Short, before Save and after");
  }

  /* --- P18: off is today's chain; a leftover hand.json changes nothing ---------------------------- */
  {
    config.shortsByHand = false;
    const id = fresh();
    handPair(id); // left over from a week the switch was on
    picks.length = 0;
    renders.length = 0;
    await save(id, { titleHook: "DOWN TO THE LAST PEARL", shortHook: "ONE PEARL FROM THE END" });
    assert.deepEqual(picks, [id], "P18: off, the chain asks the model for its pick");
    assert.deepEqual(renders, [id], "P18: off, the chain renders its own Short over the leftover");
    assert.equal(
      readFileSync(file(id, ".mp4"), "utf8"),
      "model-cut",
      "P18: the Short that went up is the render",
    );
    assert.deepEqual(
      sent.filter((s) => s.id === id).map((s) => s.kind),
      ["video", "short"],
      "P18: pick → render → upload-video → upload-short",
    );
    config.shortsByHand = true;
    console.log("OK: P18 — off is pick → render → upload; a leftover hand.json drives nothing");
  }
} finally {
  config.shortsByHand = false;
  rmSync(media, { recursive: true, force: true });
}

console.log("shortFlow.hand.contract: all checks passed");
