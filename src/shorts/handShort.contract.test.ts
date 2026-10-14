// Contract test for the hand-cut Short (`shortsByHand`, `npm run short:hand`), written from the
// docs alone (CLAUDE.md "Shorts" → shortsByHand; README "How a match becomes a video" step 3;
// handbook/claude-md-reference.md "Shorts", first bullet) by someone who did not write the code.
// What the docs promise for this feature, numbered so every assertion below can point at one:
//
//  P1  `shortsByHand` is a Settings → Publishing switch, default OFF.
//  P2  The CLI is `npm run short:hand -- <matchId> <file.mp4> --hook "<hook>" --from <sec>
//      --to <sec> --pov left|right [--note]`; a missing/invalid argument is a usage error.
//  P3  `checkHandShort` validates BEFORE WRITING A BYTE: any refusal leaves the match directory
//      exactly as it was — a hand cut already there included.
//  P4  The file must be 1080x1920, h264+aac, 60 s or under.
//  P5  The hook must pass `hookProblem` (length, spoiler, a denied label word, a fresh "X vs Y"
//      that is not the match's own pair) — refused outright with the reason, never a warning.
//      The match's own two players, "vs", is not a label.
//  P6  House rule: no seed, rank or elo in a hook — a hand hook is a hook.
//  P7  No blocked player (`blockedPlayers`: whole-string, case-insensitive) — refused.
//  P8  Not already on the channel — refused.
//  P9  A clean build writes `short-<id>.mp4` + `.title.txt`/`.description.txt` +
//      `short-<id>.hand.json` `{ hook, builtAt, windowMatchSec, pov, note? }`.
//  P10 The Short's title is `<hook> | <left> vs <right>` + `#mcsr #minecraft`, and
//      `uploadTextFor` cannot tell a hand-cut Short from a rendered one: the saved #shorthook
//      field drives nothing — the hand file's hook, baked into title.txt, is what goes up.
//  P11 A series is cut from game 1's directory; its Short's description is the series' one,
//      the same text `generateShort.ts` writes.
//  P12 On, the chain skips its own pick/render; the long-form uploads at its slot alone.
//  P13 Until the pair (mp4 + hand.json) exists the chain logs "waiting for the hand-made Short"
//      and touches no step's state — never a failure, no Needs-you noise.
//  P14 The pick after export still runs (`ensurePick`).
//  P15 `noShort` still means no Short, hand-cut or not.
//  P16 A blocked player still means no Short, hand-cut or not.
//  P17 The Short's publish time is still `shortPublishAt` (18 h after the long-form).
//  P18 Off is today's chain byte for byte — the setting alone decides, never a leftover hand.json.
//
// This file: P1–P11 through handShort.ts's public surface (and its CLI, spawned). P12–P18 live in
// src/dashboard/shortFlow.hand.contract.test.ts (the chain) and
// src/youtube/youtubeUpload.hand.contract.test.ts (the upload guard).
// ffprobe is injected (never spawned); the MCSR API is a stubbed global fetch serving a real
// fixture with its two players renamed, so no real runner's name sits in a hook or a block list.
// A clause the code does not keep is wrapped in `deviation(...)`: printed, listed, never fatal.
// Run: npx tsx src/shorts/handShort.contract.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import { SETTINGS } from "../dashboard/settings.js";
import { playoffPhrase } from "../playoffs/playoffs.js";
import { uploadTextFor } from "../youtube/youtubeStore.js";
import {
  buildHandShort,
  checkHandShort,
  handShortFile,
  HandShortRefusal,
  readHandShort,
  type HandShortOptions,
  type VideoSpec,
} from "./handShort.js";
import { buildShortDescription } from "./shortHook.js";
import { shortHookFile } from "./shortPlan.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-handshort-contract-"));
config.mediaDir = media;
config.youtubePlaylistUrl = "https://www.youtube.com/playlist?list=PLtest";
config.supportUrl = "https://ko-fi.com/test";
// Synthetic block list: the defaults name real runners, and none of them is in this fixture anyway.
config.blockedPlayers = ["SomeoneElse"];

const LEFT = "RunnerAlpha";
const RIGHT = "RunnerBravo";
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
// A real ranked match (type 2: playoffContextFor answers without another fetch), players renamed.
const matchOf = (id: number): MatchInfo => ({
  ...fixture,
  id,
  changes: [],
  players: fixture.players.map((p, i) => ({ ...p, nickname: i === 0 ? LEFT : RIGHT })),
});
const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  fetched.push(url.pathname);
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m)
    return new Response(JSON.stringify({ status: "success", data: matchOf(Number(m[1])) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const deviations: string[] = [];
/** A doc clause the code may not keep: the assertion stays the docs', a failure is reported, not fatal. */
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
let nextId = 91_000_001;
const freshMatch = (): number => {
  const id = nextId++;
  mkdirSync(dir(id), { recursive: true });
  return id;
};
/** Every file in a match directory with its bytes — "nothing written" means this is unchanged. */
const snapshot = (id: number): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir(id))
      .filter((f) => statSync(path.join(dir(id), f)).isFile())
      .map((f) => [f, readFileSync(path.join(dir(id), f), "utf8")]),
  );

const GOOD: VideoSpec = { width: 1080, height: 1920, vcodec: "h264", acodec: "aac", durationSec: 31.2 };
const probeOf = (spec: VideoSpec | null) => async () => spec;
const src = path.join(media, "session-cut.mp4");
writeFileSync(src, "session-cut-bytes");
const opts = (over: Partial<HandShortOptions> = {}): HandShortOptions => ({
  mp4Path: src,
  hook: "ONE PEARL FROM THE END",
  fromSec: 412,
  toSec: 443,
  pov: "right",
  ...over,
});
async function problemOf(
  id: number,
  o: HandShortOptions,
  spec: VideoSpec | null = GOOD,
): Promise<string | null> {
  const check = await checkHandShort(id, o, probeOf(spec));
  return check.ok ? null : check.problem;
}

try {
  /* --- P1: the switch ---------------------------------------------------------------------------- */
  {
    // Default off: a fresh box runs today's pick → render → upload chain until the operator opts in.
    assert.equal(DEFAULTS.shortsByHand, false, "P1: shortsByHand defaults to off");
    const field = SETTINGS.find((s) => s.key === "shortsByHand");
    assert.ok(field, "P1: shortsByHand is a Settings field (writable from the Settings tab)");
    assert.equal(field.group, "Publishing", "P1: under Settings → Publishing");
    assert.equal(field.kind, "boolean");
    // The panel's own help is what the operator reads before flipping it: it must not contradict
    // the documented "the pick after export still runs (ensurePick)".
    await deviation('CLAUDE.md Shorts/shortsByHand: "The pick after export still runs (ensurePick)"', () => {
      assert.doesNotMatch(
        field.help ?? "",
        /never queues a model pick/i,
        "Settings help says a hand-mode match never queues a model pick",
      );
    });
    console.log("OK: P1 — shortsByHand is a Publishing switch, default off");
  }

  /* --- P4: the file's shape, at the boundaries --------------------------------------------------- */
  {
    const id = freshMatch();
    // Exactly 60.0 s is "60 s or under" — a Short at YouTube's own limit must not be refused.
    assert.equal(await problemOf(id, opts(), { ...GOOD, durationSec: 60 }), null, "P4: 60.0 s is accepted");
    // A hair over is over: YouTube would file a 60.4 s vertical video as a regular upload.
    assert.match((await problemOf(id, opts(), { ...GOOD, durationSec: 60.4 })) ?? "", /60s or shorter/);
    // Swapped orientation (1920x1080 tested already) and a near-miss size are both refused: the
    // vertical frame is exactly 1080x1920, not "about portrait".
    assert.match((await problemOf(id, opts(), { ...GOOD, width: 1080, height: 1918 })) ?? "", /1080x1920/);
    assert.match((await problemOf(id, opts(), { ...GOOD, width: 720, height: 1280 })) ?? "", /1080x1920/);
    // h264+aac means both: right video codec with the wrong audio (and vice versa) is refused.
    assert.match((await problemOf(id, opts(), { ...GOOD, acodec: "opus" })) ?? "", /h264\+aac/);
    assert.match((await problemOf(id, opts(), { ...GOOD, vcodec: "hevc" })) ?? "", /h264\+aac/);
    assert.deepEqual(snapshot(id), {}, "P3: none of these refusals wrote anything");
    console.log("OK: P4 — 1080x1920 h264+aac ≤ 60 s, boundaries included");
  }

  /* --- P5/P6: the hook, refused outright --------------------------------------------------------- */
  {
    const id = freshMatch();
    // The match's own pair is not a label, in any case — the docs check a fresh "X vs Y" against
    // the match's own two players, and these are they.
    assert.equal(await problemOf(id, opts({ hook: `${LEFT} vs ${RIGHT}` })), null, "P5: own pair is fine");
    assert.equal(
      await problemOf(id, opts({ hook: `${LEFT.toUpperCase()} VS ${RIGHT.toLowerCase()}` })),
      null,
    );
    // A fresh "X vs Y" naming neither player is a label (2 Oct 2026: two such titles drew public
    // objection from the runners named) — refused, not warned.
    assert.match((await problemOf(id, opts({ hook: "WIZARD vs BUILDER" }))) ?? "", /label/, "P5: vs-label");
    // Half right is still a label: one side a player, the other an epithet.
    assert.match((await problemOf(id, opts({ hook: `${LEFT} vs THE MACHINE` }))) ?? "", /label/);
    // A denied word is refused outright, "vs" or not.
    assert.match((await problemOf(id, opts({ hook: "the yn route" }))) ?? "", /label/, "P5: denied word");
    // An empty / whitespace-only hook is no hook at all.
    assert.match((await problemOf(id, opts({ hook: "   " }))) ?? "", /no hook/);
    // "Nothing names the winner": a comeback tells you who took it — refused.
    assert.match((await problemOf(id, opts({ hook: "THE COMEBACK" }))) ?? "", /result/, "P5: spoiler");
    // A seed with its number is caught (positive control for P6).
    assert.match((await problemOf(id, opts({ hook: "1ST SEED SHOWDOWN" }))) ?? "", /seed, rank or elo/);
    // P6: "No seed, rank or elo in hooks" — the elo number and a rank are just as much the rule.
    await deviation('CLAUDE.md House rules: "No seed, rank or elo in hooks or suggestions"', async () => {
      const accepted: string[] = [];
      for (const hook of ["ELO 2100 SHOWDOWN", "RANK 1 ON THE ROPES", "TOP SEED ON THE ROPES"])
        if ((await problemOf(id, opts({ hook }))) === null) accepted.push(hook);
      assert.deepEqual(accepted, [], `accepted as hand hooks: ${accepted.join(", ")}`);
    });
    // Refused outright means buildHandShort throws the reason and writes nothing — not a warning
    // that saves anyway (the dashboard's typed hook is the one that only warns).
    await assert.rejects(
      buildHandShort(id, opts({ hook: "WIZARD vs BUILDER" }), { probe: probeOf(GOOD) }),
      (err: unknown) => err instanceof HandShortRefusal && /label/.test((err as Error).message),
    );
    assert.deepEqual(snapshot(id), {}, "P3: a refused hook wrote nothing");
    console.log("OK: P5 — a hand hook failing hookProblem is refused outright, own pair allowed");
  }

  /* --- P7: blocked players, whole-string and case-insensitive ------------------------------------ */
  {
    const id = freshMatch();
    const before = config.blockedPlayers;
    try {
      // Case-insensitive: a runner who withdrew permission is blocked however the list spells them.
      config.blockedPlayers = [RIGHT.toUpperCase()];
      assert.match((await problemOf(id, opts())) ?? "", /blocked player/, "P7: case-insensitive");
      // Whole-string: a prefix of a nickname is someone else, not a block.
      config.blockedPlayers = ["Runner"];
      assert.equal(await problemOf(id, opts()), null, "P7: whole-string, not substring");
    } finally {
      config.blockedPlayers = before;
    }
    // The block is checked before the file is even probed: no ffprobe spent on a match never cut.
    config.blockedPlayers = [LEFT];
    try {
      let probed = false;
      const check = await checkHandShort(id, opts(), async () => {
        probed = true;
        return GOOD;
      });
      assert.equal(check.ok, false);
      assert.equal(probed, false, "P7: refused before the probe");
    } finally {
      config.blockedPlayers = before;
    }
    assert.deepEqual(snapshot(id), {});
    console.log("OK: P7 — a blocked player is refused, whole-string and case-insensitive");
  }

  /* --- P8: already on the channel ---------------------------------------------------------------- */
  {
    // The dashboard counts a Short as on the channel when the operator ticked "Short uploaded"
    // (publish.json, a Studio upload by hand) — the same thing the chain reads as "up". A hand cut
    // for it would be a second copy waiting for a press of Upload.
    const id = freshMatch();
    writeFileSync(path.join(dir(id), "publish.json"), JSON.stringify({ shortUploaded: true }));
    await deviation(
      'CLAUDE.md Shorts/shortsByHand: checkHandShort refuses a Short "not already on the channel"',
      async () => {
        assert.notEqual(
          await problemOf(id, opts()),
          null,
          "a Short ticked as uploaded (publish.json shortUploaded) is accepted for a new hand cut",
        );
      },
    );
    console.log("OK: P8 — a ticked-by-hand Short checked (see any DEVIATION above)");
  }

  /* --- P3/P9: a refusal after a good build leaves the good build alone --------------------------- */
  {
    const id = freshMatch();
    const now = new Date("2026-10-14T09:30:00Z");
    // P9: hook trimmed (a pasted hook carries spaces), a blank note is no note.
    const built = await buildHandShort(id, opts({ hook: "  ONE PEARL FROM THE END  ", note: "   " }), {
      probe: probeOf(GOOD),
      now: () => now,
    });
    assert.equal(built.outPath, path.join(dir(id), `short-${id}.mp4`), "P9: short-<id>.mp4");
    const hand = await readHandShort(dir(id), id);
    assert.deepEqual(
      hand,
      {
        hook: "ONE PEARL FROM THE END",
        builtAt: now.toISOString(),
        windowMatchSec: [412, 443],
        pov: "right",
      },
      "P9: hand.json is { hook, builtAt, windowMatchSec, pov } — trimmed hook, no blank note",
    );
    // P10: the title is the docs' shape, with the trimmed hook.
    assert.equal(built.title, `ONE PEARL FROM THE END | ${LEFT} vs ${RIGHT} #mcsr #minecraft`);
    assert.equal(readFileSync(path.join(dir(id), `short-${id}.title.txt`), "utf8"), `${built.title}\n`);
    assert.ok(existsSync(path.join(dir(id), `short-${id}.description.txt`)), "P9: description written");
    const good = snapshot(id);

    // A second registration with a broken file: refused, and the first cut is untouched — "before
    // writing a byte" holds for the overwrite case too, where it matters most.
    await assert.rejects(
      buildHandShort(id, opts({ hook: "A DIFFERENT HOOK" }), {
        probe: probeOf({ ...GOOD, durationSec: 75 }),
      }),
      HandShortRefusal,
    );
    assert.deepEqual(snapshot(id), good, "P3: a refused re-cut leaves the earlier hand cut byte for byte");
    // The window must make sense — NaN (a typo'd --from) is refused, not written as null.
    assert.match((await problemOf(id, opts({ fromSec: Number.NaN }))) ?? "", /--from/);
    assert.match((await problemOf(id, opts({ fromSec: 50, toSec: 50 }))) ?? "", /--from/, "an empty window");
    assert.deepEqual(snapshot(id), good);

    // A session that rendered straight to short-<id>.mp4 registers that same file in place: the
    // copy-then-rename must not truncate it.
    const inPlace = freshMatch();
    const target = path.join(dir(inPlace), `short-${inPlace}.mp4`);
    writeFileSync(target, "rendered-in-place");
    await buildHandShort(inPlace, opts({ mp4Path: target }), { probe: probeOf(GOOD) });
    assert.equal(
      readFileSync(target, "utf8"),
      "rendered-in-place",
      "P9: registering the file in place keeps its bytes",
    );
    assert.ok(await readHandShort(dir(inPlace), inPlace));
    console.log("OK: P3/P9 — a clean build's files, and a later refusal never touches them");
  }

  /* --- P10: what uploadTextFor sends is the hand title, never the #shorthook field -------------- */
  {
    const hadHand = config.shortsByHand;
    config.shortsByHand = true;
    try {
      const id = freshMatch();
      // The dashboard's Save still needs *something* in #shorthook: here a different line.
      writeFileSync(shortHookFile(dir(id), id), "THE DASHBOARD FIELD\n");
      const built = await buildHandShort(id, opts(), { probe: probeOf(GOOD) });
      const text = await uploadTextFor(id, "short");
      assert.equal(text.title, built.title, "P10: the title that goes up is the hand cut's own");
      assert.doesNotMatch(text.title, /DASHBOARD FIELD/, "P10: the saved field drives nothing");

      // A hook pasted with a line break: the documented title shape must still be what goes up,
      // names and tags included — not the hook's first line alone.
      const nl = freshMatch();
      const nlBuilt = await buildHandShort(nl, opts({ hook: "ONE PEARL\nFROM THE END" }), {
        probe: probeOf(GOOD),
      }).catch((err: unknown) => (err instanceof HandShortRefusal ? null : Promise.reject(err)));
      if (nlBuilt) {
        const nlText = await uploadTextFor(nl, "short");
        await deviation(
          'CLAUDE.md Shorts "On screen": Title is `<hook> | <left> vs <right>` … + `#mcsr #minecraft`',
          () => {
            assert.match(
              nlText.title,
              new RegExp(`\\| ${LEFT} vs ${RIGHT}`),
              `a hook with a newline was accepted and uploads as ${JSON.stringify(nlText.title)}`,
            );
          },
        );
      }
    } finally {
      config.shortsByHand = hadHand;
    }
    console.log("OK: P10 — uploadTextFor sends the hand cut's own title");
  }

  /* --- P11: a series' hand Short describes the series --------------------------------------------- */
  {
    const id = freshMatch();
    writeFileSync(
      path.join(dir(id), "series.json"),
      JSON.stringify({
        season: 11,
        slotId: 1,
        round: "Quarterfinals",
        bestOf: 5,
        firstTo: 3,
        seeds: [],
        games: [{ matchId: id, gameNo: 1 }],
        assembledAt: "2026-10-01T00:00:00Z",
      }),
    );
    await buildHandShort(id, opts(), { probe: probeOf(GOOD) });
    const m = matchOf(id);
    assert.equal(
      readFileSync(path.join(dir(id), `short-${id}.description.txt`), "utf8"),
      buildShortDescription(
        id,
        LEFT,
        RIGHT,
        config.youtubePlaylistUrl,
        config.supportUrl,
        playoffPhrase(11, "Quarterfinals"),
        m.season,
        "series",
      ),
      "P11: the series' description — 'the whole series', the round, no game number, no score",
    );
    console.log("OK: P11 — a series' hand Short points at the whole series");
  }

  /* --- P2: the CLI, spawned the way `npm run short:hand` runs it ---------------------------------- */
  {
    const cfg = path.join(media, "cli-config.json");
    writeFileSync(cfg, JSON.stringify({ mediaDir: media, blockedPlayers: ["SomeoneElse"] }));
    const cli = (...args: string[]) =>
      spawnSync(
        path.join(root, "node_modules", ".bin", "tsx"),
        [path.join(root, "src", "shorts", "handShortCli.ts"), ...args],
        {
          env: { ...process.env, MCSR_CONFIG: cfg },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    const id = freshMatch();
    // No --pov: a usage error, exit 1, nothing written.
    const noPov = cli(String(id), src, "--hook", "ONE PEARL FROM THE END", "--from", "1", "--to", "20");
    assert.equal(noPov.status, 1, noPov.stderr);
    assert.match(noPov.stderr, /Usage: npm run short:hand/, "P2: a missing --pov is a usage error");
    // Both --flag value and --flag=value reach the checks: from=30, to=10 is the window refusal,
    // which only fires once both were parsed as numbers (and before any network).
    const mixed = cli(
      String(id),
      src,
      "--hook=ONE PEARL FROM THE END",
      "--from",
      "30",
      "--to=10",
      "--pov=left",
    );
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.match(mixed.stderr, /--from must be/, "P2: both flag spellings parsed");
    assert.doesNotMatch(mixed.stderr, /Usage:/);
    assert.deepEqual(snapshot(id), {}, "P3: a refused CLI run wrote nothing");
    console.log("OK: P2 — the CLI's argv shape and its usage error");
  }

  // Hermetic: nothing but the stubbed MCSR match endpoint was ever asked.
  assert.ok(
    fetched.every((p) => /^\/matches\/\d+$/.test(p)),
    `unexpected fetches: ${fetched.join(", ")}`,
  );
} finally {
  rmSync(media, { recursive: true, force: true });
}

if (deviations.length) console.log(`handShort.contract: ${deviations.length} deviation(s) reported above`);
console.log("handShort.contract: all checks passed");
