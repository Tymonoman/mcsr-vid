// Contract tests for `npm run pick -- <matchId | all> [--force] [--dry-run]`
// (src/shorts/pickCli.ts) — the command line around the picker, from CLAUDE.md first. The picker
// itself (videoPick.ts) is pinned in-process by videoPick.test.ts; this drives the CLI.
//
// Promises the docs make (CLAUDE.md Commands, handbook "Commands"):
//  1. Without `--force`, a pick newer than the export is kept — printed as is, not asked again.
//  2. `--force` asks again even then (a fresh pick replaces the kept one).
//  3. `--dry-run` asks afresh and writes nothing into the match directory.
//  4. `--dry-run` refuses (exit 1) rather than make the proxy or a /watch cache, saying why the
//     one on disk does not count ("none … run once without it").
//  5. A dry run with a current pick on disk still asks afresh (exit 0, a fresh pick printed) and
//     writes nothing — it refuses only when the proxy or a /watch cache would have to be made.
//  6. The id may be a match page URL, and flags may come before it (`<matchId | all>` is the
//     argument that is not a flag).
//
// Hermetic: temp mediaDirs via MCSR_CONFIG, a stand-in final-<id>.mp4, fetch stubbed to serve
// src/fixtures/match-12730175.json only; the reasoner, where one is configured, is never reached
// (the dry run refuses first). No ffmpeg. Run: npx tsx src/shorts/pickCli.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-pickcli-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const fixturePath = path.join(root, "src", "fixtures", "match-12730175.json");
const ID = (JSON.parse(readFileSync(fixturePath, "utf8")) as { id: number }).id;
const stub = path.join(tmp, "fetch-stub.mjs");
writeFileSync(
  stub,
  `import { readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (url.endsWith("/matches/" + fixture.id))
    return new Response(JSON.stringify({ status: "success", data: fixture }), { headers: { "content-type": "application/json" } });
  return new Response("no network in tests", { status: 503, statusText: "stubbed" });
};
`,
);

const KEPT = {
  gameMatchId: ID,
  startMs: 300_000,
  endMs: 330_000,
  pov: "both",
  focus: "right",
  hookSuggestion: "A SUGGESTION ONLY",
  why: "the kept stand-in pick",
  kind: "race",
  source: "heuristic",
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** A match with a finished video and, when asked, a pick made after it. */
function setup(name: string, opts: { pick: boolean; reasoner: boolean }) {
  const media = path.join(tmp, name);
  const dir = path.join(media, String(ID));
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, `final-${ID}.mp4`);
  writeFileSync(video, "stand-in");
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(video, hourAgo, hourAgo);
  if (opts.pick) writeFileSync(path.join(dir, `short-${ID}.pick.json`), `${JSON.stringify(KEPT, null, 2)}\n`);
  const config = path.join(tmp, `${name}.config.json`);
  writeFileSync(
    config,
    JSON.stringify({ mediaDir: media, ...(opts.reasoner ? { reasonerCommand: ["false", "{prompt}"] } : {}) }),
  );
  return { dir, config };
}
const snapshot = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => `${f} ${statSync(path.join(dir, f)).size} ${statSync(path.join(dir, f)).mtimeMs}`);

type Run = { status: number | null; stdout: string; stderr: string; dir: string; before: string[] };
function pick(name: string, opts: { pick: boolean; reasoner: boolean }, args: string[]): Promise<Run> {
  const m = setup(name, opts);
  const before = snapshot(m.dir);
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "shorts", "pickCli.ts"), ...args],
      {
        cwd: root,
        env: { ...process.env, MCSR_CONFIG: m.config, NODE_OPTIONS: `--import=${pathToFileURL(stub).href}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d));
    proc.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
    proc.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, dir: m.dir, before });
    });
  });
}
const pickOnDisk = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, `short-${ID}.pick.json`), "utf8")) as typeof KEPT;

// One at a time: the lab has four cores shared with the live dashboard.
const [kept, forced, refused, dryCurrent] = [
  await pick("kept", { pick: true, reasoner: false }, [String(ID)]),
  await pick("forced", { pick: true, reasoner: false }, [String(ID), "--force"]),
  // Flags first and a match page URL: the target is the one argument that is not a flag.
  await pick("refused", { pick: false, reasoner: true }, ["--dry-run", `https://mcsrranked.com/matches/${ID}`]),
  await pick("dry-current", { pick: true, reasoner: false }, [String(ID), "--dry-run"]),
];
for (const r of [kept, forced, refused, dryCurrent])
  assert.notEqual(r.status, null, "every run ends by itself");

/* --- 1: a pick newer than the export is kept ------------------------------------------------- */
assert.equal(kept.status, 0, kept.stderr);
assert.deepEqual(JSON.parse(kept.stdout), KEPT, "the kept pick is what is printed");
assert.deepEqual(pickOnDisk(kept.dir), KEPT, "and it stays on disk unchanged");
assert.match(kept.stderr, /kept the pick/, "the operator is told it was kept, and how to ask again");
console.log("OK: without --force a pick newer than the export is kept");

/* --- 2: --force asks again ------------------------------------------------------------------- */
assert.equal(forced.status, 0, forced.stderr);
const fresh = pickOnDisk(forced.dir);
assert.notEqual(fresh.createdAt, KEPT.createdAt, "--force replaced the kept pick with a fresh one");
assert.deepEqual(JSON.parse(forced.stdout), fresh, "and printed the one it wrote");
console.log("OK: --force asks again even when the pick on disk is current");

/* --- 3, 4, 6: --dry-run with nothing to watch yet --------------------------------------------- */
assert.equal(
  refused.status,
  1,
  `a dry run that would have to make the proxy exits 1 (stderr: ${refused.stderr})`,
);
assert.match(
  refused.stderr,
  new RegExp(`--- ${ID} \\(dry run`),
  "the URL named the match, after a leading flag",
);
assert.match(refused.stderr, /refused: .*missing.*without --dry-run/, "it says why, and what to run instead");
assert.equal(refused.stdout, "", "no pick is printed");
assert.deepEqual(snapshot(refused.dir), refused.before, "nothing in the match directory changed");
assert.equal(existsSync(path.join(refused.dir, "short-proxy.mp4")), false, "the proxy was not made");
console.log("OK: --dry-run refuses (exit 1) rather than make the proxy, and writes nothing");

/* --- 3 and 5: --dry-run when the pick on disk is current ------------------------------------- */
// The handbook's long form: a dry run "asks afresh and writes nothing" — hold it to that. (No
// reasoner is configured here, so this is the heuristic path; the refusal above covers the model's.)
assert.deepEqual(
  snapshot(dryCurrent.dir),
  dryCurrent.before,
  "a dry run writes nothing, a current pick or not",
);
assert.equal(dryCurrent.status, 0, `a current pick is no reason to refuse (stderr: ${dryCurrent.stderr})`);
assert.notEqual(
  (JSON.parse(dryCurrent.stdout) as typeof KEPT).createdAt,
  KEPT.createdAt,
  "it asked afresh and printed the new pick, not the kept one",
);
console.log("OK: --dry-run with a current pick on disk asks afresh and writes nothing");
console.log("pickCli.contract: all checks passed");
