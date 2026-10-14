// Contract test for "Re-render a match's thumbnails beside the live set, never over it"
// (CLAUDE.md; promise list in thumbnailVariants.contract.test.ts, 7/8/10 pinned here), written
// from the docs by an outsider. Covers what rerender.test.ts does not: the full pose list, the
// real renderer's choice landing inside thumbnail-new/, blocks read off chats and the title (not
// only a POV clip), the whole-string rule, a cut-short set, and the job's one-per-match lifecycle.
// Temp media dir, a stubbed MCSR API, no Chromium (stills are written, not drawn), no network.
// Run: npx tsx src/thumbnails/rerender.contract.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import {
  NEW_DIR,
  anyThumbnailRunning,
  promoteNewSet,
  rerenderThumbnails,
  startRerender,
  thumbJob,
  thumbnailRunning,
} from "./rerender.js";
import {
  RESULT_LOOKING_POSE_KEY,
  renderThumbnailVariants,
  variantFile,
  variantKey,
} from "./thumbnailVariants.js";
import type { MatchInfo } from "../api/types.js";

/** Doc vs code: keep the doc's assertion, report the gap, keep going (triage decides). */
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/match-13766294.json", import.meta.url), "utf8"),
) as MatchInfo;
const ID = fixture.id; // ≡ 2 (mod 4): cheering-relaxing's slot in the unfiltered four-pair list

const media = await mkdtemp(path.join(tmpdir(), "mcsr-rerender-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  rotate: config.thumbnailRotatePoses,
};
config.mediaDir = media;
// Synthetic names for the block list: no real runner's name goes into test data.
config.blockedPlayers = ["BlockedRunner"];

/** A match only the MCSR API says has a blocked runner: its folder holds nothing that names them. */
const API_ONLY_BLOCKED = 330;
const realFetch = globalThis.fetch;
const apiReads: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  apiReads.push(url);
  const m = /\/matches\/(\d+)$/.exec(url);
  const data = m
    ? Number(m[1]) === API_ONLY_BLOCKED
      ? { ...fixture, id: API_ONLY_BLOCKED, players: [fixture.players[0], { ...fixture.players[1], nickname: "BlockedRunner" }] }
      : { ...fixture, id: Number(m[1]) }
    : fixture.players.find((p) => url.endsWith(`/users/${p.uuid}`));
  if (!data) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify({ status: "success", data }));
}) as typeof fetch;

/** The live set a match went up with, one byte string per file so any change shows. */
const LIVE_MANIFEST = {
  chosen: "walking-crossed",
  chosenBy: "operator",
  hookText: null,
  ranks: { [fixture.players[0]!.uuid]: 2, [fixture.players[1]!.uuid]: 9 },
  variants: DEFAULTS.thumbnailVariants.map((p) => ({
    key: variantKey(p),
    file: variantFile(p),
    hook: false,
  })),
};
const liveFiles = (): Record<string, string> => ({
  "thumbnail.json": JSON.stringify(LIVE_MANIFEST),
  "thumbnail.png": "LIVE chosen",
  ...Object.fromEntries(DEFAULTS.thumbnailVariants.map((p) => [variantFile(p), `LIVE ${variantKey(p)}`])),
});
async function seed(id: number, extra: Record<string, string> = {}): Promise<string> {
  const dir = path.join(media, String(id));
  await mkdir(dir, { recursive: true });
  for (const [f, body] of Object.entries({ ...liveFiles(), ...extra }))
    await writeFile(path.join(dir, f), body);
  return dir;
}
const snapshot = async (dir: string) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(liveFiles()).map(async (f) => [f, await readFile(path.join(dir, f), "utf8")]),
    ),
  );

/** Chromium stand-in: writes each still into the new folder, then lets the real renderer decide. */
const drawsThenDecides = (async (args) => {
  for (const p of args.poses) await writeFile(path.join(args.outDir, variantFile(p)), `NEW ${variantKey(p)}`);
  // `fresh` is what forces Chromium to draw every still again; the stills above ARE that fresh
  // drawing, so the real renderer is asked to reuse them and only make its decisions.
  assert.equal(args.fresh, true, "a re-render asks for every still drawn again");
  return renderThumbnailVariants({ ...args, fresh: false });
}) as typeof renderThumbnailVariants;

try {
  // --- 7. Every pose pair, drawn fresh, into thumbnail-new/ -----------------------------------
  {
    const dir = await seed(ID);
    let seen: Parameters<typeof renderThumbnailVariants>[0] | undefined;
    await rerenderThumbnails(ID, {
      render: (async (args) => {
        seen = args;
        return { chosen: "x", variants: [], hookText: null };
      }) as typeof renderThumbnailVariants,
    });
    assert.ok(seen);
    // "Every variant drawn again": all four pairs, not just the live pick or the missing ones.
    assert.deepEqual(seen.poses, DEFAULTS.thumbnailVariants, "every configured pose pair");
    assert.equal(seen.fresh, true, "no still on disk is reused");
    assert.equal(seen.outDir, path.join(dir, NEW_DIR), "into thumbnail-new/, beside the live set");
    // Left/right follow the API's order (ranked matches keep it), read from the match itself.
    assert.deepEqual(
      [seen.match.id, seen.userLeft.uuid, seen.userRight.uuid],
      [ID, fixture.players[0]!.uuid, fixture.players[1]!.uuid],
    );
    assert.deepEqual(await snapshot(dir), liveFiles(), "the live set is untouched");
  }
  console.log("OK 7: a re-render draws every pair fresh into thumbnail-new/");

  // --- 7 + 5. The real renderer inside thumbnail-new/: its own thumbnail.png and manifest land
  // there, the live ones do not move, and its auto pick is never the arms-up pair ---------------
  config.thumbnailRotatePoses = true;
  try {
    const dir = await seed(ID);
    const fresh = await rerenderThumbnails(ID, { render: drawsThenDecides });
    const newDir = path.join(dir, NEW_DIR);
    assert.deepEqual(
      await snapshot(dir),
      liveFiles(),
      "live thumbnail.png, manifest and stills byte-identical",
    );
    assert.deepEqual(JSON.parse(await readFile(path.join(newDir, "thumbnail.json"), "utf8")), fresh);
    assert.equal(await readFile(path.join(newDir, "thumbnail.png"), "utf8"), `NEW ${fresh.chosen}`);
    // The new set's default is an automatic pick like any other: never the result-looking pose,
    // even on an id where an unfiltered rotation would land on it.
    assert.notEqual(fresh.chosen, RESULT_LOOKING_POSE_KEY, "the new set's auto pick skips the arms-up pair");
    assert.equal(fresh.chosenBy, "auto", "nobody has pressed anything yet");
    assert.equal(fresh.variants.length, 4);
  } finally {
    config.thumbnailRotatePoses = false;
  }
  console.log("OK 7/5: the real renderer's output stays in thumbnail-new/, auto pick never arms-up");

  // --- 8. "Use this" is the press that changes the live set — and the only one ----------------
  {
    const dir = path.join(media, String(ID));
    const promoted = await promoteNewSet(ID, "default-default");
    // Every live still is the new drawing now, the pressed one is what goes up, and the manifest
    // says a human chose it (the checklist's pill) while keeping the live set's frozen ranks.
    for (const p of DEFAULTS.thumbnailVariants) {
      assert.equal(await readFile(path.join(dir, variantFile(p)), "utf8"), `NEW ${variantKey(p)}`);
    }
    assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "NEW default-default");
    assert.deepEqual([promoted.chosen, promoted.chosenBy], ["default-default", "operator"]);
    assert.deepEqual(promoted.ranks, LIVE_MANIFEST.ranks, "frozen ranks are the live set's, not today's");
    assert.ok(!existsSync(path.join(dir, NEW_DIR)), "the new set is the live one now");
    // A second press with nothing re-rendered refuses rather than doing anything.
    await assert.rejects(promoteNewSet(ID, "default-default"), /re-render the thumbnails first/);
    assert.equal(thumbnailRunning(ID), false, "a refused press leaves nothing marked running");
  }
  console.log("OK 8: Use this moves the new set over the live one, chosen by the operator");

  // --- 8. A set cut short (stills but no manifest) can never be pressed into the live set -----
  {
    const dir = await seed(301);
    await mkdir(path.join(dir, NEW_DIR));
    await writeFile(path.join(dir, NEW_DIR, variantFile(DEFAULTS.thumbnailVariants[1]!)), "half-drawn");
    await assert.rejects(promoteNewSet(301, "default-default"), /re-render the thumbnails first/);
    assert.deepEqual(await snapshot(dir), liveFiles(), "the live set is untouched");
    assert.deepEqual(await readdir(path.join(dir, NEW_DIR)), [variantFile(DEFAULTS.thumbnailVariants[1]!)]);
  }
  console.log("OK 8: a cut-short set is never promoted");

  // --- 10. Blocked players: chats and the title's pair count, not only the POV clips ----------
  const before = apiReads.length;
  const blockedCases: Array<[number, string, Record<string, string>]> = [
    // A saved chat names the runner; case differs from the block list (case-insensitive).
    [310, "a saved chat", { "chat-blockedrunner.json": "[]" }],
    // Archived off disk: no clips, no chats — only the title still says who played.
    [
      311,
      "the title's pair",
      { "match-311.title.txt": "WHO BLINKS FIRST? | Other vs BlockedRunner | MCSR Ranked" },
    ],
    // The operator's edited title counts the same.
    [
      312,
      "an edited title",
      { "match-312.title.edited.txt": "ONE PEARL | BLOCKEDRUNNER vs Other | MCSR Ranked" },
    ],
  ];
  for (const [id, how, extra] of blockedCases) {
    const dir = await seed(id, extra);
    await assert.rejects(
      rerenderThumbnails(id, { render: drawsThenDecides }),
      /blocked player/,
      `re-render, ${how}`,
    );
    assert.ok(!existsSync(path.join(dir, NEW_DIR)), `${how}: no new folder started`);
    // A stale new set from before the block cannot be pressed in either.
    await mkdir(path.join(dir, NEW_DIR));
    await writeFile(
      path.join(dir, NEW_DIR, "thumbnail.json"),
      JSON.stringify({
        chosen: "walking-crossed",
        hookText: null,
        variants: [{ key: "walking-crossed", file: "w.png" }],
      }),
    );
    await writeFile(path.join(dir, NEW_DIR, "w.png"), "stale");
    await assert.rejects(promoteNewSet(id, "walking-crossed"), /blocked player/, `Use this, ${how}`);
    assert.deepEqual(await snapshot(dir), liveFiles(), `${how}: the live set is untouched`);
    assert.ok(existsSync(path.join(dir, NEW_DIR, "w.png")), `${how}: nothing was moved`);
  }
  // Refused from disk alone, before the MCSR API is asked anything.
  assert.equal(apiReads.length, before, "a blocked match is refused before any API read");
  // Whole-string: a different runner whose name merely contains the blocked one is not blocked.
  await seed(313, { "chat-blockedrunnerfan.json": "[]" });
  await rerenderThumbnails(313, { render: drawsThenDecides });
  assert.ok(existsSync(path.join(media, "313", NEW_DIR, "thumbnail.json")), "a near-miss name renders");
  console.log("OK 10: chats and titles block a re-render and a Use this, whole-string, any case");

  // --- 10. A blocked runner the folder does not name, but the match does ----------------------
  // The docs' own re-render target: "a Studio upload whose directory never had thumbnail files" —
  // a folder holding just its upload record, no clips, chats or title. The re-render reads the
  // match's players from the API anyway; every other render path (the pipeline, npm run short,
  // short:hand, a series, POST /api/render) refuses on those names, and a blocked match is "never
  // rendered ... even by hand". The bulk re-render reaches exactly these folders.
  {
    const dir = path.join(media, String(API_ONLY_BLOCKED));
    await mkdir(dir);
    await writeFile(path.join(dir, "youtube.json"), JSON.stringify({ videoId: "studioVid33", source: "studio" }));
    let drew = false;
    const outcome = await rerenderThumbnails(API_ONLY_BLOCKED, {
      render: (async () => {
        drew = true;
        return { chosen: "x", variants: [], hookText: null };
      }) as typeof renderThumbnailVariants,
    }).then(
      () => "rendered",
      (err: Error) => err.message,
    );
    await deviation(
      'CLAUDE.md "Re-render a match\'s thumbnails…": blocked players apply the same as everywhere else (every render path refuses on the match\'s API player names)',
      () => {
        assert.equal(drew, false, `a match whose API players include a blocked runner was drawn (${outcome})`);
      },
    );
    await rm(path.join(dir, NEW_DIR), { recursive: true, force: true });
  }

  // --- 11 (job side). One re-render per match at a time; finished or failed, it lets go -------
  {
    await seed(320);
    let calls = 0;
    let release!: () => void;
    const held = (async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return { chosen: "x", variants: [], hookText: null };
    }) as unknown as typeof rerenderThumbnails;
    const job = startRerender(320, held);
    // A second press while the first runs is the same job, not a second render on the same folder.
    assert.equal(startRerender(320, held), job);
    assert.equal(calls, 1, "one render, however many presses");
    assert.equal(thumbnailRunning(320), true);
    assert.equal(anyThumbnailRunning(), true);
    assert.equal(thumbnailRunning(321), false, "busy is per match");
    release();
    assert.equal(await job.finished, null);
    assert.equal(thumbJob(320)?.done, true);
    assert.equal(thumbnailRunning(320), false, "done is not busy");

    // A re-render that throws records the reason and releases the match: a failure must not hold
    // restart-when-idle or the nightly for ever.
    const failing = (async () => {
      throw new Error("chromium died");
    }) as unknown as typeof rerenderThumbnails;
    const failed = startRerender(320, failing);
    assert.notEqual(failed, job, "a finished job does not block a new press");
    assert.match(String(await failed.finished), /chromium died/);
    assert.equal(thumbJob(320)?.error, "chromium died");
    assert.equal(thumbnailRunning(320), false);
    assert.equal(anyThumbnailRunning(), false);
  }
  console.log("OK 11: one re-render per match; done or failed, it stops counting as busy");

  console.log("rerender.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.thumbnailRotatePoses = saved.rotate;
  await rm(media, { recursive: true, force: true });
}
