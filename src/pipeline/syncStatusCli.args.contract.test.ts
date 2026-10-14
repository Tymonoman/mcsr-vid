// Contract tests for `npm run sync-status -- [matchId]` (src/pipeline/syncStatusCli.ts): its
// arguments and what its listing says, from CLAUDE.md first, as an outside engineer would. The
// backfill itself (derive, source "derived", confidence 0, an existing file kept, a bare match
// left alone) is main's P10/P11 in syncStatusCli.contract.test.ts; this file covers the rest.
//
// Promises the docs make (CLAUDE.md Commands + Known pitfalls, handbook "Commands"):
//  1. No id lists every match and writes nothing anywhere under the media dir.
//  2. The listing shows the offsets a backfill would derive and the command that writes them; a
//     hand fix is shown as one; a match with neither file names the preRollSec estimate.
//  6. Every `mediaDir` scan is `/^\d+$/`: a non-numeric directory (`clips/`) is skipped.
//  7. The id may be a match page URL (README: "Commands accept a match id or a match page URL").
//
// Hermetic: a temp mediaDir via MCSR_CONFIG, removed on exit; the `.kdenlive` is built by the real
// project builder. No network, no ffmpeg. Run: npx tsx src/pipeline/syncStatusCli.args.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKdenliveProject } from "./kdenliveProject.js";

function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-syncstatus-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const media = path.join(tmp, "media");
const configPath = path.join(tmp, "config.json");
writeFileSync(configPath, JSON.stringify({ mediaDir: media }));

const BACKFILL = 13_000_101; // a .kdenlive, no sync.json
const MANUAL = 13_000_102; // a .kdenlive *and* a hand-fixed sync.json
const BARE = 13_000_103; // neither
const BY_URL = 13_000_104; // a .kdenlive, no sync.json — asked for by match page URL

function project(id: number, left: number, right: number): void {
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
      projectName: `match-${id}`,
    }),
  );
}
project(BACKFILL, 153.9, 155.2);
project(MANUAL, 140, 141);
project(BY_URL, 151.5, 149.25);
mkdirSync(path.join(media, String(BARE)), { recursive: true });
const manualSync = `${JSON.stringify({ left: 150.5, right: 152.25, confidence: 1, detail: "fixed by hand", source: "manual" }, null, 2)}\n`;
writeFileSync(path.join(media, String(MANUAL), "sync.json"), manualSync);
// A clip directory with a project in it: not a match, so no scan may treat it as one.
mkdirSync(path.join(media, "clips", "some-slug"), { recursive: true });

type Run = { status: number | null; stdout: string; stderr: string };
function syncStatus(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "pipeline", "syncStatusCli.ts"), ...args],
      { cwd: root, env: { ...process.env, MCSR_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d));
    proc.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
    proc.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
/** Every file under the media dir with its size and mtime: "writes nothing" means this is unchanged. */
function snapshot(dir = media): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .sort()
    .map((rel) => {
      const st = statSync(path.join(dir, rel));
      return `${rel} ${st.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`;
    });
}
const syncOf = (id: number) => path.join(media, String(id), "sync.json");

/* --- 1, 2, 6: the listing ------------------------------------------------------------------- */
const before = snapshot();
const list = await syncStatus();
assert.equal(list.status, 0, list.stderr);
assert.deepEqual(snapshot(), before, "a listing writes nothing anywhere under the media dir");
assert.equal(existsSync(syncOf(BACKFILL)), false, "not even the sync.json it could derive");
const lines = list.stdout.trim().split("\n");
for (const id of [BACKFILL, MANUAL, BARE, BY_URL])
  assert.ok(
    lines.some((l) => l.startsWith(`${id}:`)),
    `match ${id} is listed`,
  );
assert.ok(
  lines.some((l) => l.startsWith(`${BACKFILL}:`) && /153\.90/.test(l) && /155\.20/.test(l)),
  "the listing shows the offsets it would derive",
);
assert.ok(
  lines.some((l) => l.includes(`npm run sync-status -- ${BACKFILL}`)),
  "and the command that writes them",
);
assert.ok(
  lines.some((l) => l.startsWith(`${MANUAL}:`) && /150\.50/.test(l) && /manual/.test(l)),
  "the hand fix is shown as such",
);
assert.ok(
  lines.some((l) => l.startsWith(`${BARE}:`) && /no sync\.json/.test(l) && /150s estimate/.test(l)),
  "a bare match falls back to preRollSec",
);
assert.ok(!lines.some((l) => l.startsWith("clips")), "the non-numeric clips/ directory is not a match");
assert.equal(
  lines.filter((l) => /^\d+: /.test(l)).length,
  lines.length,
  "every line is about a numbered match",
);
console.log("OK: no id lists every match directory and writes nothing");

/* --- 7: the id as a match page URL, and the backfill's message --------------------------------- */
// One at a time: the lab has four cores shared with the live dashboard.
const backfill = await syncStatus(String(BACKFILL));
const byUrl = await syncStatus(`https://mcsrranked.com/matches/${BY_URL}`);
for (const r of [backfill, byUrl]) assert.notEqual(r.status, null, "every run ends by itself");

assert.equal(backfill.status, 0, backfill.stderr);
assert.match(backfill.stdout, /re-export/, "the operator is told the fix needs a re-export");
console.log("OK: a backfill tells the operator to re-export");

deviation("README: Commands accept a match id or a match page URL (npm run sync-status -- <url>)", () => {
  assert.ok(
    existsSync(syncOf(BY_URL)),
    `sync-status by URL must backfill match ${BY_URL} (stdout: ${byUrl.stdout.trim()})`,
  );
});
assert.equal(
  existsSync(path.join(media, "NaN")),
  false,
  "whatever it does with a URL, it creates no stray directory",
);

console.log("syncStatusCli.args.contract: all checks passed");
