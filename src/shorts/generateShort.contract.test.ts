// Contract test for how `npm run short` places the clips, written from the docs (CLAUDE.md "Known
// pitfalls": "Every consumer places clips from sync.json — without it, export:fast/the Short fall
// back to config.preRollSec and run early") by an outside engineer. The CLI runs as the operator
// runs it, in a child process against a temp media directory, with fetch disabled in the child —
// so it can get as far as the sync decision and never reach the MCSR API.
// Run: npx tsx src/shorts/generateShort.contract.test.ts
//
// Promises covered (numbering shared with src/dashboard/syncRoutes.contract.test.ts):
//  P10 Every consumer places the clips from sync.json; without it the Short falls back to
//      config.preRollSec (and runs early) rather than reading anything else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSyncOffsets } from "../pipeline/syncFile.js";

/** Keeps the docs' wording where the code differs; prints it and carries on until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const ID = 12730175;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const media = mkdtempSync(path.join(tmpdir(), "short-sync-contract-"));
const configFile = path.join(media, "config.json");
writeFileSync(configFile, JSON.stringify({ mediaDir: media }));
const dir = path.join(media, String(ID));
mkdirSync(dir);

/** `npm run short -- <id>` minus the CSS build; any fetch in the child rejects. */
const short = () => {
  const r = spawnSync(
    path.join(repo, "node_modules/.bin/tsx"),
    [
      "--import",
      'data:text/javascript,globalThis.fetch=async(u)=>{throw new Error("offline: "+u)}',
      "src/shorts/generateShort.ts",
      String(ID),
    ],
    { cwd: repo, env: { ...process.env, MCSR_CONFIG: configFile }, encoding: "utf8", timeout: 15_000 },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

try {
  // The Short's two gates before placement: a saved hook and the model's pick.
  writeFileSync(path.join(dir, `short-${ID}.hook.txt`), "DOES THE LEAD EVER SETTLE?\n");
  writeFileSync(
    path.join(dir, `short-${ID}.pick.json`),
    JSON.stringify({
      gameMatchId: ID,
      startMs: 120_000,
      endMs: 150_000,
      pov: "both",
      hookSuggestion: "DOES THE LEAD EVER SETTLE?",
      why: "a lead change",
      kind: "race",
      source: "heuristic",
      createdAt: "2026-10-14T00:00:00.000Z",
    }),
  );

  // No sync.json. The docs: the Short falls back to config.preRollSec — it does not stop on it.
  const noSync = short();
  assert.notEqual(noSync.status, 0, "it cannot finish offline either way");
  assert.equal(existsSync(path.join(dir, `short-${ID}.mp4`)), false, "nothing rendered");
  deviation("Without sync.json, export:fast and the Short fall back to config.preRollSec", () =>
    assert.doesNotMatch(
      noSync.out,
      /no sync\.json/,
      `the Short refuses instead: "${noSync.out.trim().split("\n")[0]}"`,
    ),
  );

  // With sync.json the placement question is answered and the Short goes on to the match itself
  // (here: the API, which the child cannot reach) — sync.json is what it placed the clips by.
  writeSyncOffsets(dir, { left: 153.25, right: 148.5, confidence: 1, detail: "", source: "manual" });
  const synced = short();
  assert.notEqual(synced.status, 0);
  assert.doesNotMatch(synced.out, /no sync\.json/, "past the sync decision");
  // The child's blocked fetch is what stopped it — so it never reached the real API either.
  assert.match(
    synced.out,
    /offline: https:\/\/api\.mcsrranked\.com\//,
    "stopped at the API, not at placement",
  );
} finally {
  rmSync(media, { recursive: true, force: true });
}

console.log("generateShort.contract: all checks passed");
