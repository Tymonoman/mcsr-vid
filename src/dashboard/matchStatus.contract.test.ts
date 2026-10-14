// Contract test for the disk-side half of "Blocked players" (src/dashboard/matchStatus.ts), from the
// docs alone (CLAUDE.md "Blocked players"; handbook/claude-md-reference.md, same bullet). Promises:
//
//   1. `blockedOnDisk` reads the POV clips (`<nickname>.mp4`), the saved chats (`chat-<nick>.json`)
//      AND the title's "A vs B" pair — "not clips alone, so a match archived off disk is still caught".
//   2. Each source is enough on its own: clips only, chats only, the title only (generated or the
//      operator's `.edited.txt`).
//   3. Whole-string, case-insensitive, the same as everywhere (a lower-cased clip name still blocks).
//   4. The pipeline's own MP4s (`overlay-timer.mp4`, `final-<id>.mp4`, …) are never read as a player.
//   5. The title pair is found in every title the pipeline writes: a ranked title, a playoff game's
//      ("| MCSR Ranked Season N Playoffs | …"), and a hook that itself has " | " or "vs" in it.
//   6. `titleNames` spells a player the broadcast's way in the title only — the archived-match
//      promise in 1 still has to hold for a player the title spells that way.
//   7. `matchIsBlocked` (the gate in front of POST /api/render, /api/render/:id and
//      /api/series/:id/render): the API's pair, else `blockedOnDisk` on the directory — so a renamed
//      runner whose old clips sit on disk is still refused, and a down API alone refuses nobody.
//
// The render routes themselves live in server.ts, which listens on import; they are exercised here
// through `matchIsBlocked`, the one function every one of them calls before starting a run.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/matchStatus.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS, matchDir } from "../config.js";
import { blockedOnDisk, matchIsBlocked } from "./matchStatus.js";

// A doc promise the code does not keep: printed and listed, never fatal (main's contract files' way).
const deviations: string[] = [];
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

const media = mkdtempSync(path.join(tmpdir(), "mcsr-matchstatus-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  titleNames: config.titleNames,
  fetch: globalThis.fetch,
};
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];

/** A match directory holding exactly these files (text content; the gate never opens a clip). */
let nextId = 70_000_001;
const dirWith = (files: Record<string, string>, id = nextId++): string => {
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
};
const title = (pair: string, hook = "WHO BLINKS FIRST?", tail = "MCSR Ranked 1v1 | Minecraft Speedrun") =>
  `${hook} | ${pair} | ${tail}\n`;

// The MCSR API: a real fixture served under whatever id is asked, or down.
const served = new Map<number, MatchInfo | "down">();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const answer = m ? served.get(Number(m[1])) : undefined;
  if (!answer || answer === "down") throw new Error(`network unavailable in this test: ${url}`);
  return new Response(JSON.stringify({ status: "success", data: { ...answer, id: Number(m![1]) } }));
}) as typeof fetch;

try {
  // --- 1/2. Each source alone is enough ------------------------------------------------------------
  // The live state of a freshly downloaded match: both POV clips beside the pipeline's own files.
  assert.equal(
    blockedOnDisk(dirWith({ "BlazeMind.mp4": "", "Aquacorde.mp4": "", "overlay-top.png": "" })),
    true,
    "a blocked runner's POV clip on disk",
  );
  // Archived to the NAS, clips gone: the chats still say who played (11 Oct 2026, four such matches).
  assert.equal(
    blockedOnDisk(dirWith({ "chat-hackingnoises.json": "[]", "chat-BeefSalad.json": "[]" })),
    true,
    "the saved chats alone",
  );
  // Clips and chats both gone: the generated title still carries the pair.
  assert.equal(
    blockedOnDisk(dirWith({ "match-1.title.txt": title("hackingnoises vs BeefSalad") })),
    true,
    "the generated title alone",
  );
  {
    const id = nextId++;
    // Only the operator's edit survives (the generated one regenerates): the edit is a title too.
    assert.equal(
      blockedOnDisk(dirWith({ [`match-${id}.title.edited.txt`]: title("BlazeMind vs Aquacorde") }, id)),
      true,
      "the operator's edited title alone",
    );
  }
  // The control: every source present, nobody on the list in any of them.
  assert.equal(
    blockedOnDisk(
      dirWith({
        "edcr.mp4": "",
        "doogile.mp4": "",
        "chat-edcr.json": "[]",
        "chat-doogile.json": "[]",
        "match-1.title.txt": title("edcr vs doogile"),
      }),
    ),
    false,
    "a clean match is not blocked",
  );
  assert.equal(blockedOnDisk(path.join(media, "no-such-dir")), false, "no directory, nobody named");
  console.log(
    "OK: blockedOnDisk — clips, chats and the title each block on their own; a clean match does not",
  );

  // --- 3. Case, on disk --------------------------------------------------------------------------
  assert.equal(
    blockedOnDisk(dirWith({ "aquacorde.mp4": "", "BlazeMind.mp4": "" })),
    true,
    "a lower-cased clip",
  );
  assert.equal(blockedOnDisk(dirWith({ "chat-BEEFSALAD.json": "[]" })), true, "an upper-cased chat");
  assert.equal(
    blockedOnDisk(dirWith({ "match-1.title.txt": title("doogile vs Aquacorde2") })),
    false,
    "whole names only: a longer nickname in the title is somebody else",
  );
  console.log("OK: blockedOnDisk compares whole names, ignoring case");

  // --- 4. Generated MP4s are not players ---------------------------------------------------------
  config.blockedPlayers = ["overlay-timer", "final-5", "short-5", "series-5", "smoke-5"];
  assert.equal(
    blockedOnDisk(
      dirWith({
        "overlay-timer.mp4": "",
        "final-5.mp4": "",
        "short-5.mp4": "",
        "series-5.mp4": "",
        "smoke-5.mp4": "",
      }),
    ),
    false,
    "the pipeline's own MP4s never stand in for a player's clip (27 Sept 2026: overlay-timer read as a player)",
  );
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  console.log("OK: the pipeline's generated MP4s are never read as a player");

  // --- 5. Every title shape the pipeline writes --------------------------------------------------
  assert.equal(
    blockedOnDisk(
      dirWith({
        "match-1.title.txt": title(
          "BlazeMind vs Aquacorde",
          "ROUND OF 16",
          "MCSR Ranked Season 11 Playoffs | Round of 16 | Game 2",
        ),
      }),
    ),
    true,
    "a playoff game's title (playoffTitleTail)",
  );
  assert.equal(
    blockedOnDisk(
      dirWith({
        "match-1.title.txt": title(
          "hackingnoises vs BeefSalad",
          "",
          "MCSR Ranked Season 11 Playoffs | Final",
        ),
      }),
    ),
    true,
    "a joined series' title (playoffSeriesTail)",
  );
  // A typed hook is saved as typed (only < > and newlines are touched), so " | " and "vs" can be in it.
  assert.equal(
    blockedOnDisk(
      dirWith({ "match-1.title.txt": title("doogile vs BeefSalad", "ONE HEART | ME vs THE CLOCK") }),
    ),
    true,
    "a hook with its own ' | ' and 'vs' does not hide the real pair",
  );
  console.log("OK: the title pair is read from ranked, playoff, series and pipe-in-the-hook titles");

  // --- 6. A titleNames spelling, archived ---------------------------------------------------------
  // titleNames spells a runner the broadcast's way (the default maps two real ones; a made-up runner
  // here). Blocked, an archived match of his (clips and chats gone) names him in its title only as
  // the spelling.
  config.titleNames = { Runnerx: "Spelled" };
  config.blockedPlayers = ["Runnerx"];
  const spelled = dirWith({ "match-1.title.txt": title("Spelled vs doogile") });
  deviation(
    "CLAUDE.md Blocked players: title pair checked 'so a match archived off disk is still caught' (titleNames spelling)",
    () =>
      assert.equal(
        blockedOnDisk(spelled),
        true,
        "a blocked player the title spells via titleNames is not caught",
      ),
  );
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  config.titleNames = saved.titleNames;

  // --- 7. matchIsBlocked: the render routes' gate ---------------------------------------------------
  // A brand-new render: no directory yet, the API's pair decides (fixture: BlazeMind vs Aquacorde).
  served.set(70_100_001, fixture(12902901));
  assert.equal(await matchIsBlocked(70_100_001), true, "the API's pair names Aquacorde");
  // Same, BeefSalad's real match.
  served.set(70_100_002, fixture(13549300));
  assert.equal(await matchIsBlocked(70_100_002), true, "the API's pair names BeefSalad");
  // The control: edcr vs doogile renders.
  served.set(70_100_003, fixture(12730175));
  assert.equal(await matchIsBlocked(70_100_003), false, "a clean pair is not refused");
  // A renamed runner: the API now says someone else, the old POV clip on disk still says who it was.
  served.set(70_100_004, fixture(12730175));
  dirWith({ "Aquacorde.mp4": "", "doogile.mp4": "" }, 70_100_004);
  assert.equal(await matchIsBlocked(70_100_004), true, "the directory still names the blocked runner");
  // The API down and no directory: degraded to "?" nicknames, which block nobody — never a refusal
  // the operator could not explain.
  served.set(70_100_005, "down");
  assert.equal(await matchIsBlocked(70_100_005), false, "a down API alone refuses nothing");
  // The API down, an archived directory whose chats name the runner: refused anyway.
  served.set(70_100_006, "down");
  dirWith({ "chat-Aquacorde.json": "[]" }, 70_100_006);
  assert.equal(await matchIsBlocked(70_100_006), true, "an archived directory blocks with the API down");
  console.log("OK: matchIsBlocked — the API's pair, else the directory; a down API alone blocks nobody");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.titleNames = saved.titleNames;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

if (deviations.length) console.log(`${deviations.length} deviation(s) from the docs — see DEVIATION lines`);
console.log("matchStatus.contract: all checks passed");
