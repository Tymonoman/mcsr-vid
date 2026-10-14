// Contract tests for `npm run short -- <matchId> [--at=<ms>] [--seconds=N]`
// (src/shorts/generateShort.ts) — its refusals, from CLAUDE.md first, as an outside engineer.
// generateShort.test.ts already pins the `shortsByHand` gate; this covers the others.
//
// Promises the docs make (CLAUDE.md Commands + Shorts, handbook "Commands"):
//  1. Refuses without the operator's hook (`short-<id>.hook.txt`) — "No Short renders and
//     nothing uploads before the operator saves the hooks".
//  2. A hook file with nothing in it is no saved hook.
//  3. Refuses once the Short is on YouTube (`youtube-short.json`) — "after upload hooks lock",
//     a new cut would need a re-upload.
//  4. The Short is "cut from the pick's window": with no pick there is nothing to cut.
//  5. `--at=<ms>` / `--seconds=N` override the window by hand — so a value that is not a number
//     is refused rather than cut at NaN.
//  6. Every refusal exits non-zero and writes nothing: no `short-<id>.mp4`, no title/description,
//     no `short-<id>.cut.json`.
//  7. The id may be a match page URL (README: "Commands accept a match id or a match page URL").
//
// Hermetic: a temp mediaDir via MCSR_CONFIG; every refusal comes before the match record is read,
// and fetch is stubbed to log and fail anyway. Run: npx tsx src/shorts/generateShort.refusals.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WAITING_FOR_HOOK } from "./shortHook.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-genshort-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const media = path.join(tmp, "media");
const configPath = path.join(tmp, "config.json");
writeFileSync(configPath, JSON.stringify({ mediaDir: media }));
const fetchLog = path.join(tmp, "fetch.log");
writeFileSync(fetchLog, "");
const stub = path.join(tmp, "no-network.mjs");
writeFileSync(
  stub,
  `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  appendFileSync(${JSON.stringify(fetchLog)}, String(input?.url ?? input) + "\\n");
  return new Response("no network in tests", { status: 503, statusText: "stubbed" });
};
`,
);

const HOOK = "CAN ANYONE CATCH THIS PACE?"; // a question, names nobody, no result
const pick = (id: number) =>
  JSON.stringify({
    gameMatchId: id,
    startMs: 120_000,
    endMs: 150_000,
    pov: "both",
    focus: "left",
    hookSuggestion: "A SUGGESTION ONLY",
    why: "stand-in",
    kind: "race",
    source: "heuristic",
    createdAt: "2026-10-01T00:00:00.000Z",
  });

/** One match directory per case, so each "writes nothing" check sees only its own run. */
function matchWith(id: number, files: Record<string, string>): string {
  const dir = path.join(media, String(id));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(dir, name.replace("<id>", String(id))), body);
  return dir;
}
const snapshot = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => `${f} ${statSync(path.join(dir, f)).size} ${statSync(path.join(dir, f)).mtimeMs}`);

type Run = { status: number | null; stdout: string; stderr: string };
function short(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "shorts", "generateShort.ts"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          MCSR_CONFIG: configPath,
          NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`,
        },
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
      resolve({ status, stdout, stderr });
    });
  });
}

const cases: {
  id: number;
  what: string;
  files: Record<string, string>;
  args: (id: number) => string[];
  expect: RegExp;
}[] = [
  {
    id: 13_000_201,
    what: "no hook saved (asked by match page URL)",
    files: { "short-<id>.pick.json": pick(13_000_201) },
    args: (id: number) => [`https://mcsrranked.com/matches/${id}`],
    // Promise 1 + 7: the URL resolved to this match, and the hook gate named it.
    expect: new RegExp(`${WAITING_FOR_HOOK}.*match 13000201`),
  },
  {
    id: 13_000_202,
    what: "a blank hook file",
    files: { "short-<id>.hook.txt": "   \n\n", "short-<id>.pick.json": pick(13_000_202) },
    args: (id: number) => [String(id)],
    expect: new RegExp(WAITING_FOR_HOOK),
  },
  {
    id: 13_000_203,
    what: "the Short already on YouTube",
    files: {
      "short-<id>.hook.txt": `${HOOK}\n`,
      "short-<id>.pick.json": pick(13_000_203),
      "youtube-short.json": JSON.stringify({ videoId: "stand-in-id" }),
    },
    args: (id: number) => [String(id)],
    expect: /already on the channel/,
  },
  {
    id: 13_000_204,
    what: "no pick",
    files: { "short-<id>.hook.txt": `${HOOK}\n` },
    args: (id: number) => [String(id)],
    expect: /no pick for 13000204/,
  },
  {
    id: 13_000_205,
    what: "--seconds that is not a number",
    files: { "short-<id>.hook.txt": `${HOOK}\n`, "short-<id>.pick.json": pick(13_000_205) },
    args: (id: number) => [String(id), "--seconds=twenty"],
    expect: /--at and --seconds must be numbers/,
  },
  {
    id: 13_000_206,
    what: "--at that is not a number",
    files: { "short-<id>.hook.txt": `${HOOK}\n`, "short-<id>.pick.json": pick(13_000_206) },
    args: (id: number) => [String(id), "--at=1:30"],
    expect: /--at and --seconds must be numbers/,
  },
];
const dirs = cases.map((c) => matchWith(c.id, c.files));
const before = dirs.map(snapshot);
// One at a time: the lab has four cores shared with the live dashboard.
const runs: Run[] = [];
for (const c of cases) runs.push(await short(...c.args(c.id)));

for (const [i, c] of cases.entries()) {
  const r = runs[i]!;
  assert.equal(r.status, 1, `${c.what}: a refusal exits 1 (stderr: ${r.stderr})`);
  assert.match(r.stderr, c.expect, `${c.what}: says why`);
  assert.doesNotMatch(r.stderr, /\n\s+at /, `${c.what}: one line the dashboard can show, not a stack`);
  assert.equal(r.stdout, "", `${c.what}: no JSON result on stdout`);
  // Promise 6.
  assert.deepEqual(snapshot(dirs[i]!), before[i], `${c.what}: nothing in the match directory changed`);
  console.log(`OK: npm run short refuses — ${c.what}`);
}
assert.equal(readFileSync(fetchLog, "utf8"), "", "every refusal came before the MCSR API was asked anything");
assert.deepEqual(
  readdirSync(media).sort(),
  cases.map((c) => String(c.id)).sort(),
  "no other directory was created (and no .short-picks.jsonl line was logged)",
);

console.log("generateShort.refusals.contract: all checks passed");
