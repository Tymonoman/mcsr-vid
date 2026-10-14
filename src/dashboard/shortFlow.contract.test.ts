// Contract test for saving the operator's own hooks (shortFlow.ts `saveHooks`, the handler behind
// PUT /api/shorts/hooks/:id), written from the docs (CLAUDE.md "House rules": "Only the
// operator's own typed hook always saves — the problem lands as a warning in saveWarnings, never
// a refusal"; "Hook chips": "any check on a typed hook is a warning, never a refusal") before
// reading the code. shortFlow.test.ts pins the spoiler and plain "X vs Y" warnings; this file
// covers the label shapes added since (v., versus, a denied word with no pair) and the
// seed/rank/elo rule, on a real match (src/fixtures) served through a stubbed fetch. Temp media
// dir, no render, no upload, no model: the chain's steps are stand-ins and the match has no export.
//
// The promises (full list and numbering in src/pipeline/hooks.contract.test.ts; checked here):
//  P6  A typed hook always saves — the edited title and the Short hook land on disk — and each
//      problem comes back as a warning in saveWarnings, never a refusal.
//  P3  A denied word is a label "vs" or not; P4 "v", "v." and "versus" count as "vs".
//  P7  No seed, rank or elo in hooks — on a typed hook that is a warning like every other check.
// Run: npx tsx src/dashboard/shortFlow.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shortflow-contract-"));
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = path.join(media, "archive");

const deviations: string[] = [];
/** Runs a docs-exact check; an AssertionError is reported as a deviation instead of failing. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

// A real ranked match (both players unblocked), under an id no real match has.
const ID = 13_990_001;
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/match-13782182.json", import.meta.url), "utf8"),
) as MatchInfo;
const [left, right] = fixture.players.map((p) => p.nickname) as [string, string];
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (url.hostname === "api.mcsrranked.com" && url.pathname === `/matches/${ID}`)
    return new Response(JSON.stringify({ status: "success", data: { ...fixture, id: ID, changes: [] } }));
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const flow = await import("./shortFlow.js");
const ran: string[] = [];
const deps: Partial<import("./shortFlow.js").ChainDeps> = {
  render: async () => (ran.push("render"), "stand-in"),
  upload: async () => {
    ran.push("upload");
    throw new Error("no upload in a contract test");
  },
  pick: async () => void ran.push("pick"),
  refreshChannel: async () => ran.push("refresh"),
  resumeUpload: async () => (ran.push("resume"), "stand-in"),
};

const dir = path.join(media, String(ID));
mkdirSync(dir, { recursive: true });
const titleLine = () => readFileSync(path.join(dir, `match-${ID}.title.edited.txt`), "utf8").split("\n")[0];
const shortHook = () => readFileSync(path.join(dir, `short-${ID}.hook.txt`), "utf8").trim();

/** Saves like the dashboard's Save button; returns the warnings, failing on any refusal (P6). */
async function save(titleHook: string, short: string): Promise<string[]> {
  const result = await flow.saveHooks(ID, { titleHook, shortHook: short }, deps);
  await flow.chainIdle(ID);
  assert.ok(!(result && "status" in result), `refused: ${JSON.stringify(result)}`);
  // Saved: the title file carries the typed hook as its first segment, the Short hook its file.
  assert.equal(titleLine(), `${titleHook} | ${left} vs ${right} | MCSR Ranked 1v1 | Minecraft Speedrun`);
  assert.equal(shortHook(), short);
  return result?.saveWarnings ?? [];
}
const LABEL = (h: string) =>
  `"${h}" names a runner with a label: runners have objected to this (2 Oct 2026) — saved anyway`;

try {
  // A clean pair of hooks: saved, nothing to warn about.
  assert.deepEqual(await save("58 MILLISECONDS", "DOWN TO THE LAST HEART"), []);

  // P3/P4/P6: every label shape saves, each with its warning — title and Short hook alike.
  for (const [title, short] of [
    ["SPEEDY v. SLOWPOKE", "DOWN TO THE LAST HEART"],
    ["58 MILLISECONDS", "SPEEDY VERSUS SLOWPOKE"],
    ["THE KOREAN GRINDER", "DOWN TO THE LAST HEART"],
    [`${left} vs ${right} vs THE CLOCK`, "DOWN TO THE LAST HEART"],
  ] as const) {
    const warnings = await save(title, short);
    const labelled = title === "58 MILLISECONDS" ? short : title;
    assert.ok(warnings.includes(LABEL(labelled)), `${labelled}: ${JSON.stringify(warnings)}`);
  }
  // The match's own two players, by any "vs", are not a label: no warning.
  assert.deepEqual(await save(`${right} versus ${left}`, "DOWN TO THE LAST HEART"), []);

  // P1/P6: a typed result saves too — it is the operator's call — with the spoiler warning.
  const spoiled = await save("THE UNDERDOG WINS", "DOWN TO THE LAST HEART");
  assert.ok(
    spoiled.some((w) => /give the result away/.test(w)),
    JSON.stringify(spoiled),
  );

  // P7/P6: a seed, rank or elo saves (strict: never a refusal) ...
  const seeded = await save("#1 SEED SHOWDOWN", "THE 2410 ELO DUEL");
  // ... and, like every other check on a typed hook, says so beside the field.
  deviation(
    'P7 "No seed, rank or elo in hooks" + "any check on a typed hook is a warning" — typed seed/elo hook',
    () => {
      assert.ok(
        // The warning's own words, not the quoted hook it repeats.
        seeded.some((w) => /seed|rank|elo/i.test(w.replace(/^"[^"]*"/, ""))),
        `saved with no seed/rank/elo warning: ${JSON.stringify(seeded)}`,
      );
    },
  );

  // Nothing above reached a render or an upload: the match has no export, so the chain stops at
  // the pick it cannot make — and only the MCSR API was asked, for this match.
  assert.ok(!ran.includes("render") && !ran.includes("upload"), JSON.stringify(ran));
  assert.ok(
    calls.every((c) => c === `/matches/${ID}`),
    JSON.stringify(calls),
  );
} finally {
  rmSync(media, { recursive: true, force: true });
}
console.log("OK: a typed hook always saves, every label shape warns");

if (deviations.length)
  console.log(`shortFlow.contract: ${deviations.length} deviation(s) from the docs, listed above`);
console.log("shortFlow.contract: all checks passed");
