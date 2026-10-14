// Contract tests for the CLI argument gate (src/cliArgs.ts `requireArg`) and the missing-id
// refusal of every match command in CLAUDE.md's Commands table — written from the docs, as an
// outside engineer would, before reading the source.
//
// Promises the docs make (CLAUDE.md "Commands", README "Commands accept a match id or a match
// page URL. Extra arguments go after `--`.", handbook/claude-md-reference.md "Commands"):
//  1. Every match command takes `<matchId>` first; without it the command refuses with a usage
//     line naming its own npm script, and exits non-zero.
//  2. That refusal happens before anything is read or written — no match directory is created.
//  3. `requireArg` hands back argv[2] verbatim (parsing is `parseMatchId`'s job, so a URL survives).
//  4. `requireArg`'s default usage says the argument may be a match page URL or a match id.
//  5. A command with its own usage text (short:hand) prints that text instead.
//
// Hermetic: every spawned CLI gets a temp MCSR_CONFIG whose mediaDir is a temp dir; no command
// gets far enough to reach the network (fetch is stubbed anyway, and any call is logged).
// Run: npx tsx src/cliArgs.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireArg } from "./cliArgs.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-cliargs-contract-"));
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

/* --- requireArg, in process ---------------------------------------------------------------- */
class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}
function callRequireArg(argv: string[], ...args: Parameters<typeof requireArg>) {
  const saved = { argv: process.argv, exit: process.exit, error: console.error };
  const errors: string[] = [];
  process.argv = argv;
  process.exit = ((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit;
  console.error = (...parts: unknown[]) => void errors.push(parts.map(String).join(" "));
  try {
    return { value: requireArg(...args), exit: null as number | undefined | null, errors };
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    return { value: null, exit: err.code, errors };
  } finally {
    process.argv = saved.argv;
    process.exit = saved.exit;
    console.error = saved.error;
  }
}

// Promise 3: argv[2] comes back untouched — a match page URL must reach parseMatchId whole, or
// "Commands accept a match id or a match page URL" (README) could not hold for any command.
{
  const url = "https://mcsrranked.com/matches/12730175?tab=timeline#splits";
  const r = callRequireArg(["node", "script.ts", url, "--cpu"], "export:fast");
  assert.equal(r.value, url, "the URL is handed on verbatim, query and hash included");
  assert.equal(r.exit, null, "a present argument never exits");
  assert.deepEqual(r.errors, [], "and prints nothing");
}
// Promise 1 + 4: no argument → one usage line for that script, exit 1. The default text names both
// accepted forms so the operator knows a pasted URL works.
{
  const r = callRequireArg(["node", "script.ts"], "export:fast");
  assert.equal(r.exit, 1, "a missing id exits 1");
  assert.deepEqual(r.errors, ["Usage: npm run export:fast -- <match page URL or match ID>"]);
}
// An empty string (`npm run short -- ""`, a shell variable that was never set) is no id either:
// it must not fall through to parseMatchId's less helpful "Could not find a match ID in """.
{
  const r = callRequireArg(["node", "script.ts", ""], "short");
  assert.equal(r.exit, 1, "an empty argument is a missing argument");
  assert.match(r.errors[0] ?? "", /^Usage: npm run short -- /);
}
// Promise 5: a command's own usage text replaces the default, after the documented `--`.
{
  const r = callRequireArg(["node", "script.ts"], "short:hand", "<matchId> <file.mp4> --hook …");
  assert.equal(r.exit, 1);
  assert.deepEqual(r.errors, ["Usage: npm run short:hand -- <matchId> <file.mp4> --hook …"]);
}
console.log("OK: requireArg returns argv[2] verbatim and refuses a missing one with the script's usage line");

/* --- every documented match command, spawned without its id -------------------------------- */
type Run = { status: number | null; stdout: string; stderr: string };
function cli(script: string, args: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(path.join(root, "node_modules", ".bin", "tsx"), [path.join(root, script), ...args], {
      cwd: root,
      env: { ...process.env, MCSR_CONFIG: configPath, NODE_OPTIONS: `--import=${pathToFileURL(stub).href}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

// The Commands table's match commands and the npm script each is run as (package.json).
const commands: { npm: string; script: string; usage: RegExp }[] = [
  { npm: "export:fast", script: "src/pipeline/exportFastCli.ts", usage: /npm run export:fast -- </ },
  { npm: "short", script: "src/shorts/generateShort.ts", usage: /npm run short -- </ },
  {
    npm: "short:hand",
    script: "src/shorts/handShortCli.ts",
    // CLAUDE.md: `<matchId> <file.mp4> --hook "<hook>" --from <sec> --to <sec> --pov left|right [--note]`
    usage: /npm run short:hand -- <matchId> .*--hook .*--from .*--to .*--pov left\|right/,
  },
  {
    npm: "pick",
    script: "src/shorts/pickCli.ts",
    usage: /npm run pick -- <matchId \| all> \[--force\] \[--dry-run\]/,
  },
  {
    npm: "series",
    script: "src/playoffs/seriesCli.ts",
    usage: /npm run series -- <matchId \| all> \[--join-only\]/,
  },
  { npm: "chat", script: "src/cli/chatCli.ts", usage: /npm run chat -- <matchId>/ },
];
const runs = await Promise.all(commands.map((c) => cli(c.script)));
for (const [i, c] of commands.entries()) {
  const r = runs[i]!;
  // Promise 1: a refusal, not a crash and not a silent success.
  assert.notEqual(r.status, 0, `npm run ${c.npm} with no id must fail (stderr: ${r.stderr})`);
  assert.notEqual(r.status, null, `npm run ${c.npm} with no id must exit by itself, not hang`);
  assert.match(r.stderr, c.usage, `npm run ${c.npm} names its own usage`);
  assert.doesNotMatch(r.stderr, /\n\s+at /, `npm run ${c.npm}: a usage line, not a stack trace`);
  assert.equal(r.stdout, "", `npm run ${c.npm}: nothing on stdout, where the JSON result would go`);
}
// Promise 2: nothing was created under the media dir and nothing was fetched.
assert.equal(existsSync(media), false, "no match directory (or media dir) is created by a refused command");
assert.equal(readFileSync(fetchLog, "utf8"), "", "no API call is made before the id is known");
console.log(
  `OK: ${commands.length} match commands refuse a missing id with their usage line, touching nothing`,
);

// `sync-status` is the one command whose id is optional; with none it lists (its own contract
// test covers what), so it must not refuse an empty media dir either.
{
  mkdirSync(media);
  const r = await cli("src/pipeline/syncStatusCli.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No match directories/, "an empty media dir is reported, not a crash");
  assert.deepEqual(readdirSync(media), [], "and listing created nothing");
}
console.log("OK: sync-status without an id is a listing, not a refusal");

console.log("cliArgs.contract: all checks passed");
