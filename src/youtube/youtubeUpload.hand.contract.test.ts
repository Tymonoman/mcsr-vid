// Contract test for the upload guard (`hookRefusal`, `beginUpload`) in hand mode
// (`shortsByHand`), written from the docs alone (CLAUDE.md "Shorts" → shortsByHand and "No Short
// renders and nothing uploads before the operator saves the hooks"; "Blocked players";
// handbook/claude-md-reference.md "Shorts", first bullet). The full numbered promise list is at
// the top of src/shorts/handShort.contract.test.ts; this file holds the upload guard's half:
//
//  H1  Nothing uploads before the operator saves the hooks — `hookRefusal` is named as one of
//      the places that holds it.
//  P8  A Short already on the channel never goes up again, hand-cut or not.
//  P13 In hand mode the Short to upload is the pair `short-<id>.mp4` + `short-<id>.hand.json`;
//      until both are readable the guard says "waiting for the hand-made Short". A leftover
//      model cut is not that pair.
//  P15 `noShort` still means no Short, hand-cut or not.
//  P16 A blocked player still means no Short, hand-cut or not — checked on disk (POV clips,
//      saved chats, the title's "A vs B"), whole-string and case-insensitive.
//  P18 Off is today's guard: the setting alone decides, never a leftover hand.json.
//  P3  `checkHandShort` validates before writing a byte — a hand Short it accepted must not be
//      one the upload then refuses on its own text.
//
// Disk-only: the guard reads files, so every state is a file written into a temp media dir. The
// one `beginUpload` call injects its `send` (videos.insert) — nothing reaches YouTube; the MCSR
// API is a stubbed global fetch serving a real fixture with its players renamed.
// Run: npx tsx src/youtube/youtubeUpload.hand.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-upload-hand-contract-"));
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = path.join(media, "archive");
config.youtubeUploadEnabled = true;
config.blockedPlayers = ["SomeoneElse"];

const LEFT = "RunnerAlpha";
const RIGHT = "RunnerBravo";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m)
    return new Response(
      JSON.stringify({
        status: "success",
        data: {
          ...fixture,
          id: Number(m[1]),
          changes: [],
          players: fixture.players.map((p, i) => ({ ...p, nickname: i === 0 ? LEFT : RIGHT })),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const { beginUpload, hookRefusal } = await import("./youtubeUpload.js");
const { buildHandShort, HandShortRefusal } = await import("../shorts/handShort.js");

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

const dir = (id: number) => path.join(media, String(id));
const file = (id: number, suffix: string) => path.join(dir(id), `short-${id}${suffix}`);
let nextId = 93_000_001;
/** A match whose hooks are saved (the edited title and the Short's hook, as Save writes them). */
function saved(id = nextId++): number {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), `match-${id}.title.edited.txt`),
    `DOWN TO THE LAST PEARL | ${LEFT} vs ${RIGHT} | MCSR Ranked 1v1\n`,
  );
  writeFileSync(file(id, ".hook.txt"), "ONE PEARL FROM THE END\n");
  writeFileSync(
    file(id, ".status.json"),
    JSON.stringify({ hooksSavedAt: "2026-10-14T08:00:00Z", steps: {}, errors: [] }),
  );
  return id;
}
/** What `npm run short:hand` leaves: the mp4, the hand file, and the title/description it builds. */
function handPair(id: number, parts: { mp4?: boolean; hand?: string } = {}): number {
  if (parts.mp4 !== false) writeFileSync(file(id, ".mp4"), "hand-cut-bytes");
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
  return id;
}
const short = (id: number) => hookRefusal(id, "short");

try {
  config.shortsByHand = true;

  /* --- P13: the pair, and only the pair ----------------------------------------------------------- */
  {
    // The full pair behind saved hooks: the guard lets it through (positive control for the rest).
    assert.equal(
      await short(handPair(saved())),
      null,
      "P13: a saved match with the hand pair may upload its Short",
    );

    // Nothing cut yet: refused with the documented words.
    const none = await short(saved());
    assert.equal(none?.status, 409);
    assert.match(none?.error ?? "", /waiting for the hand-made Short/, "P13: the guard's words");
    // hand.json without its mp4, and a hand.json cut off mid-write beside its mp4.
    assert.match(
      (await short(handPair(saved(), { mp4: false })))?.error ?? "",
      /waiting for the hand-made Short/,
    );
    assert.match(
      (await short(handPair(saved(), { hand: '{"hook": "ONE PE' })))?.error ?? "",
      /waiting for the hand-made Short/,
    );
    // A leftover model cut (mp4 + cut.json matching the saved hook): with the switch on, the
    // session cuts every Short — a model cut is not the hand-made one.
    const leftover = saved();
    writeFileSync(file(leftover, ".mp4"), "model-cut");
    writeFileSync(
      file(leftover, ".cut.json"),
      JSON.stringify({ hook: "ONE PEARL FROM THE END", pickCreatedAt: "x" }),
    );
    assert.match(
      (await short(leftover))?.error ?? "",
      /waiting for the hand-made Short/,
      "P13: a model cut is not the pair",
    );
    console.log("OK: P13 — the guard wants the hand pair, nothing less, nothing else");
  }

  /* --- P8: once on the channel ------------------------------------------------------------------ */
  {
    const id = handPair(saved());
    writeFileSync(path.join(dir(id), "youtube-short.json"), JSON.stringify({ videoId: "short-x" }));
    const refused = await short(id);
    assert.equal(refused?.status, 409, "P8: a Short goes up once — the hand pair does not change that");
    assert.match(refused?.error ?? "", /already on the channel/);
    console.log("OK: P8 — a Short already on the channel never goes up again");
  }

  /* --- P16: blocked players, read off the disk ---------------------------------------------------- */
  {
    const before = config.blockedPlayers;
    try {
      // The title's "A vs B" (a match archived off disk keeps its title), case-insensitive.
      config.blockedPlayers = [RIGHT.toLowerCase()];
      const byTitle = handPair(saved());
      assert.equal((await short(byTitle))?.status, 403, "P16: the title's pair names a blocked runner");
      // A saved chat names the runner too, even with the title gone.
      config.blockedPlayers = ["ChatOnlyRunner"];
      const byChat = handPair(saved());
      writeFileSync(path.join(dir(byChat), "chat-ChatOnlyRunner.json"), "[]");
      assert.equal((await short(byChat))?.status, 403, "P16: a saved chat names a blocked runner");
      // A POV clip named for the runner.
      config.blockedPlayers = ["ClipRunner"];
      const byClip = handPair(saved());
      writeFileSync(path.join(dir(byClip), "ClipRunner.mp4"), "pov");
      assert.equal((await short(byClip))?.status, 403, "P16: a POV clip names a blocked runner");
      // Whole-string: a prefix of a nickname is someone else.
      config.blockedPlayers = ["Runner"];
      assert.equal(await short(handPair(saved())), null, "P16: whole-string, not a substring match");
    } finally {
      config.blockedPlayers = before;
    }
    console.log("OK: P16 — a blocked runner refuses the hand-cut Short (title, chat, clip), whole-string");
  }

  /* --- P15: noShort ----------------------------------------------------------------------------- */
  {
    // Save with "No Short for this one": status noShort, no hook file (Save removes it).
    const id = saved();
    rmSync(file(id, ".hook.txt"));
    writeFileSync(
      file(id, ".status.json"),
      JSON.stringify({ hooksSavedAt: "2026-10-14T08:00:00Z", noShort: true, steps: {}, errors: [] }),
    );
    handPair(id); // the session cut one anyway
    await deviation(
      'CLAUDE.md Shorts/shortsByHand: "noShort/a blocked player still mean no Short either way"',
      async () => {
        assert.notEqual(
          await short(id),
          null,
          "hand mode: a noShort match with the hand pair on disk passes hookRefusal (a Publish → Upload Short press sends it)",
        );
      },
    );
    // The same match with the switch off is refused (no hook file): the gap is hand mode's own.
    config.shortsByHand = false;
    assert.notEqual(await short(id), null, "P18: off, a noShort match's Short is refused");
    config.shortsByHand = true;
    console.log("OK: P15 — noShort against the upload guard checked (see any DEVIATION above)");
  }

  /* --- H1: nothing uploads before the operator saves the hooks ---------------------------------- */
  {
    // The session cut and registered a Short; the operator has saved nothing yet.
    const id = nextId++;
    mkdirSync(dir(id), { recursive: true });
    handPair(id);
    assert.notEqual(await hookRefusal(id, "video"), null, "H1: the long-form is refused before Save");
    await deviation(
      'CLAUDE.md Shorts: "No Short renders and nothing uploads before the operator saves the hooks (… youtubeUpload.ts hookRefusal …)"',
      async () => {
        assert.notEqual(
          await short(id),
          null,
          "hand mode: the Short passes hookRefusal with no hooks saved at all",
        );
      },
    );
    console.log("OK: H1 — the guard before Save checked (see any DEVIATION above)");
  }

  /* --- P18: off is today's guard; a leftover hand pair passes nothing ------------------------------ */
  {
    config.shortsByHand = false;
    const id = handPair(saved());
    const refused = await short(id);
    assert.equal(refused?.status, 409, "P18: off, a hand pair with no cut behind the saved hook is refused");
    assert.doesNotMatch(refused?.error ?? "", /hand-made/, "P18: off, the guard never speaks of hand mode");
    // And the ordinary path still works: a model cut behind the saved hook goes through.
    writeFileSync(
      file(id, ".cut.json"),
      JSON.stringify({ hook: "ONE PEARL FROM THE END", pickCreatedAt: "x" }),
    );
    assert.equal(await short(id), null, "P18: off, today's rule — the cut behind the saved hook");
    config.shortsByHand = true;
    console.log("OK: P18 — off, the guard is today's: the setting alone decides");
  }

  /* --- P3: what checkHandShort accepted, the upload must take --------------------------------------- */
  {
    const id = saved();
    const src = path.join(media, "session-cut.mp4");
    writeFileSync(src, "session-cut-bytes");
    const good = { width: 1080, height: 1920, vcodec: "h264", acodec: "aac", durationSec: 30 };
    const built = await buildHandShort(
      id,
      { mp4Path: src, hook: "I <3 THIS SEED", fromSec: 300, toSec: 330, pov: "left" },
      { probe: async () => good },
    ).catch((err: unknown) => (err instanceof HandShortRefusal ? null : Promise.reject(err)));
    if (built) {
      const begun = await beginUpload(id, { kind: "short", privacyStatus: "private" }, async () => {
        throw new Error("stub: videos.insert is never called for real here");
      });
      if (!("error" in begun)) await begun.finished;
      await deviation(
        'handbook "Shorts": short:hand "Validates before writing a byte (checkHandShort)" — a hand Short it accepts must be uploadable',
        () => {
          assert.ok(
            !("error" in begun),
            `the hook "I <3 THIS SEED" passes checkHandShort, then every upload refuses: ${"error" in begun ? begun.error : ""}`,
          );
        },
      );
    }
    console.log("OK: P3 — a hand Short's text against the upload's own title rules checked");
  }
} finally {
  config.shortsByHand = false;
  rmSync(media, { recursive: true, force: true });
}

if (deviations.length)
  console.log(`youtubeUpload.hand.contract: ${deviations.length} deviation(s) reported above`);
console.log("youtubeUpload.hand.contract: all checks passed");
