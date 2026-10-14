// Contract tests for `npm run short:hand -- <matchId> <file.mp4> --hook "<hook>" --from <sec>
// --to <sec> --pov left|right [--note]` (src/shorts/handShortCli.ts) — the argument parsing and the
// refusals reachable without the network. handShort.test.ts pins `checkHandShort` in process
// (file shape, hook, blocked players); this drives the command line.
//
// Promises the docs make (CLAUDE.md Commands + Shorts `shortsByHand`):
//  1. The documented shape is `--hook "<hook>" --from <sec> --to <sec> --pov left|right`
//     (space-separated values); the rest of the CLIs use `--flag=value`, and both reach the checks.
//  2. `--pov` is `left` or `right`, nothing else; a missing `--hook`, `--from`, `--to` or file is
//     a usage line, exit non-zero.
//  3. Refused outright when the Short is already on the channel (`youtube-short.json`).
//  4. A window that ends before it starts is refused.
//  5. "validates first": every refusal writes nothing — no `short-<id>.mp4`, `.title.txt`,
//     `.description.txt` or `short-<id>.hand.json`.
//  6. The id may be a match page URL (README: "Commands accept a match id or a match page URL").
//
// Hermetic: a temp mediaDir via MCSR_CONFIG; every case stops before the match record is read
// (fetch is stubbed to log and fail anyway). No ffprobe. Run: npx tsx src/shorts/handShortCli.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-handshort-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const media = path.join(tmp, "media");
const configPath = path.join(tmp, "config.json");
writeFileSync(configPath, JSON.stringify({ mediaDir: media, shortsByHand: true }));
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

const UPLOADED = 13_000_301; // its Short is on the channel
const FRESH = 13_000_302; // not uploaded
for (const id of [UPLOADED, FRESH]) mkdirSync(path.join(media, String(id)), { recursive: true });
writeFileSync(
  path.join(media, String(UPLOADED), "youtube-short.json"),
  JSON.stringify({ videoId: "stand-in-id" }),
);
const clip = path.join(tmp, "hand-cut.mp4");
writeFileSync(clip, "stand-in");
const HOOK = "CAN ANYONE CATCH THIS PACE?";

const snapshot = () =>
  readdirSync(media, { recursive: true, encoding: "utf8" })
    .sort()
    .map((rel) => `${rel} ${statSync(path.join(media, rel)).mtimeMs}`);

type Run = { status: number | null; stdout: string; stderr: string };
function hand(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "shorts", "handShortCli.ts"), ...args],
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

const USAGE = /^Usage: npm run short:hand -- /m;
const ON_CHANNEL = /already on the channel/;
const cases: { what: string; args: string[]; expect: RegExp }[] = [
  // Promise 1 + 3: the documented, space-separated form reaches the on-channel refusal...
  {
    what: "documented --flag value form, Short on the channel",
    args: [String(UPLOADED), clip, "--hook", HOOK, "--from", "65", "--to", "95", "--pov", "left"],
    expect: ON_CHANNEL,
  },
  // ...and so does --flag=value, in another order, with the optional --note.
  {
    what: "--flag=value form, Short on the channel",
    args: [
      String(UPLOADED),
      clip,
      "--pov=right",
      "--to=95",
      "--from=65",
      `--hook=${HOOK}`,
      "--note=stand-in",
    ],
    expect: ON_CHANNEL,
  },
  // Promise 6.
  {
    what: "match page URL, Short on the channel",
    args: [
      `https://mcsrranked.com/matches/${UPLOADED}`,
      clip,
      "--hook",
      HOOK,
      "--from",
      "65",
      "--to",
      "95",
      "--pov",
      "left",
    ],
    expect: ON_CHANNEL,
  },
  // Promise 2.
  {
    what: "--pov that is neither left nor right",
    args: [String(FRESH), clip, "--hook", HOOK, "--from", "65", "--to", "95", "--pov", "both"],
    expect: USAGE,
  },
  {
    what: "no --hook",
    args: [String(FRESH), clip, "--from", "65", "--to", "95", "--pov", "left"],
    expect: USAGE,
  },
  {
    what: "no --to",
    args: [String(FRESH), clip, "--hook", HOOK, "--from", "65", "--pov", "left"],
    expect: USAGE,
  },
  {
    what: "no file (a flag in its place)",
    args: [String(FRESH), "--hook", HOOK, "--from", "65", "--to", "95", "--pov", "left"],
    expect: USAGE,
  },
  // Promise 4.
  {
    what: "a window that ends before it starts",
    args: [String(FRESH), clip, "--hook", HOOK, "--from", "95", "--to", "65", "--pov", "left"],
    expect: /--from must be .* lower than --to/,
  },
];
const before = snapshot();
// One at a time: the lab has four cores shared with the live dashboard.
const runs: Run[] = [];
for (const c of cases) runs.push(await hand(...c.args));
for (const [i, c] of cases.entries()) {
  const r = runs[i]!;
  assert.equal(r.status, 1, `${c.what}: exits 1 (stderr: ${r.stderr})`);
  assert.match(r.stderr, c.expect, `${c.what}: says why`);
  assert.doesNotMatch(r.stderr, /\n\s+at /, `${c.what}: a line, not a stack`);
  assert.equal(r.stdout, "", `${c.what}: no JSON result`);
  console.log(`OK: npm run short:hand refuses — ${c.what}`);
}
// Promise 5.
assert.deepEqual(snapshot(), before, "no refusal wrote anything into the media dir");
assert.equal(readFileSync(clip, "utf8"), "stand-in", "the operator's own file is untouched");
assert.equal(readFileSync(fetchLog, "utf8"), "", "every refusal came before the match record was read");

console.log("handShortCli.contract: all checks passed");
