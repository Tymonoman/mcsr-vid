// Contract test for `npm run sync-status`, written from the docs (CLAUDE.md Commands: "Where a
// match's POV clips sit; derives/writes sync.json if missing. No id lists everything, writes
// nothing"; Known pitfalls: "npm run sync-status backfills") by an outside engineer. The CLI runs
// as the operator runs it, in a child process, against a temp media directory.
// Run: npx tsx src/pipeline/syncStatusCli.contract.test.ts
//
// Promises covered (numbering shared with src/dashboard/syncRoutes.contract.test.ts):
//  P11 `sync-status -- <id>` with no sync.json derives one from the match's .kdenlive and writes
//      it; with no id it lists every match and writes nothing.
//  P10 Without sync.json (and nothing to derive it from) the clips fall back to config.preRollSec.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { buildKdenliveProject } from "./kdenliveProject.js";
import { readSyncOffsets, syncFilePath, writeSyncOffsets } from "./syncFile.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const media = mkdtempSync(path.join(tmpdir(), "sync-status-contract-"));
const configFile = path.join(media, "config.json");
writeFileSync(configFile, JSON.stringify({ mediaDir: media }));

const syncStatus = (...args: string[]): string =>
  execFileSync(path.join(repo, "node_modules/.bin/tsx"), ["src/pipeline/syncStatusCli.ts", ...args], {
    cwd: repo,
    env: { ...process.env, MCSR_CONFIG: configFile },
    encoding: "utf8",
    timeout: 15_000,
  });

/** A match rendered before sync.json existed: its .kdenlive is the only record of the placement. */
function renderedBeforeSyncJson(id: number, left: number, right: number): string {
  const dir = path.join(media, String(id));
  mkdirSync(dir, { recursive: true });
  const clip = (name: string, offset: number) => ({
    path: path.join(dir, `${name}.mp4`),
    durationSec: 900,
    matchOffsetIntoClipSec: offset,
    clipName: name,
  });
  writeFileSync(
    path.join(dir, `match-${id}.kdenlive`),
    buildKdenliveProject({
      fps: 60,
      width: 1920,
      height: 1080,
      root: dir,
      leftClip: clip("left", left),
      rightClip: clip("right", right),
      overlayClips: [],
      projectName: `match ${id}`,
    }),
  );
  return dir;
}

try {
  const old = renderedBeforeSyncJson(111, 153.25, 148.5);
  const synced = path.join(media, "222");
  mkdirSync(synced);
  writeSyncOffsets(synced, { left: 151, right: 152, confidence: 0.9, detail: "video", source: "countdown" });
  const syncedAt = statSync(syncFilePath(synced)).mtimeMs;
  const bare = path.join(media, "333"); // no sync.json, no project
  mkdirSync(bare);

  // --- P11: no id lists every match and writes nothing -----------------------------------------
  {
    const out = syncStatus();
    for (const id of ["111", "222", "333"]) assert.match(out, new RegExp(`^${id}:`, "m"), `${id} listed`);
    assert.equal(existsSync(syncFilePath(old)), false, "listing does not backfill");
    assert.equal(existsSync(syncFilePath(bare)), false);
    assert.equal(statSync(syncFilePath(synced)).mtimeMs, syncedAt, "nor rewrite a match's sync.json");
    // P10: the bare match is told what its clips fall back to.
    assert.match(out, new RegExp(`^333:.*${config.preRollSec}s`, "m"));
  }

  // --- P11: with an id, derive from the .kdenlive and write it ---------------------------------
  {
    syncStatus("111");
    const written = readSyncOffsets(old);
    assert.ok(written, "sync.json written from the project");
    // The placement the project carries, read back to the millisecond — a re-export then picks
    // up the corrected offsets without a re-render.
    assert.ok(Math.abs(written.left - 153.25) < 0.001, `left ${written.left}`);
    assert.ok(Math.abs(written.right - 148.5) < 0.001, `right ${written.right}`);
    assert.equal(written.source, "derived");
    // The project keeps the placement, not the score: no confidence is claimed for it.
    assert.equal(written.confidence, 0);
  }

  // An id that already has sync.json: reported, never overwritten (a manual or detector file
  // outranks a derivation).
  {
    const out = syncStatus("222");
    assert.match(out, /countdown/);
    assert.equal(statSync(syncFilePath(synced)).mtimeMs, syncedAt, "left alone");
  }

  // An id with nothing to derive from: said, and nothing invented.
  {
    syncStatus("333");
    assert.equal(existsSync(syncFilePath(bare)), false, "no project, no sync.json");
  }
} finally {
  rmSync(media, { recursive: true, force: true });
}

console.log("syncStatusCli.contract: all checks passed");
