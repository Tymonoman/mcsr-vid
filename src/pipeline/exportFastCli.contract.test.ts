// Contract tests for `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]`
// (src/pipeline/exportFastCli.ts) — from CLAUDE.md first, as an outside engineer would.
//
// Promises the docs make (CLAUDE.md Commands + Known pitfalls, handbook "Commands"):
//  1. `--seconds` → a smoke test written to `smoke-<id>.mp4`, "never the real final" — it once
//     wrote over a published match's final, which became a 20-second stub.
//  2. A smoke run never writes `final-<id>.json` (the export record), so a published video's
//     record of where match start sits is left alone.
//  3. A smoke run renders a short range: N seconds of output.
//  4. Without `--seconds`, the export is `final-<id>.mp4` plus `final-<id>.json`
//     `{ matchStartSec }` — 10 for the default 7 s intro card (`introSec + 3`).
//  5. `--cpu` encodes in software (libx264) even where the VAAPI node exists.
//  6. `--full-tail` keeps the whole rendered overlay span instead of trimming the tail.
//  7. The id may be a match page URL (README: "Commands accept a match id or a match page URL").
//
// Hermetic: ffmpeg/ffprobe are tiny shell stand-ins first on PATH (ffmpeg records its argv and
// touches the output it was given; ffprobe answers a fixed duration), and fetch is stubbed to
// serve src/fixtures/match-12730175.json and nothing else. Nothing is encoded.
// Run: npx tsx src/pipeline/exportFastCli.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-exportfast-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const fixturePath = path.join(root, "src", "fixtures", "match-12730175.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  id: number;
  players: { nickname: string }[];
};
const ID = fixture.id;

// Stand-in binaries: never encode, never take more than a millisecond.
const bin = path.join(tmp, "bin");
mkdirSync(bin);
writeFileSync(
  path.join(bin, "ffmpeg"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_FFMPEG_LOG"
for a in "$@"; do case "$a" in *.part.mp4) printf 'ENCODED' > "$a";; esac; done
exit 0
`,
);
writeFileSync(
  path.join(bin, "ffprobe"),
  `#!/bin/sh
for a in "$@"; do last="$a"; done
case "$last" in *.webm) echo 7.000000;; *) echo 600.000000;; esac
`,
);
chmodSync(path.join(bin, "ffmpeg"), 0o755);
chmodSync(path.join(bin, "ffprobe"), 0o755);

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

const PUBLISHED = "PUBLISHED FINAL — must survive a smoke run";
const PUBLISHED_RECORD = `${JSON.stringify({ matchStartSec: 6 }, null, 2)}\n`;

/** A rendered match: every overlay artifact and both POV clips, plus an already-published final. */
function renderedMatch(name: string) {
  const media = path.join(tmp, name);
  const dir = path.join(media, String(ID));
  mkdirSync(dir, { recursive: true });
  for (const f of ["overlay-top.png", "overlay-timer.mp4", "overlay-intro.webm", "overlay-splits-0.png"])
    writeFileSync(path.join(dir, f), "stand-in");
  for (const p of fixture.players) writeFileSync(path.join(dir, `${p.nickname}.mp4`), "stand-in");
  writeFileSync(
    path.join(dir, "overlay-splits.json"),
    JSON.stringify([{ path: path.join(dir, "overlay-splits-0.png"), startSec: 0, durationSec: 600 }]),
  );
  writeFileSync(path.join(dir, `final-${ID}.mp4`), PUBLISHED);
  writeFileSync(path.join(dir, `final-${ID}.json`), PUBLISHED_RECORD);
  const config = path.join(tmp, `${name}.config.json`);
  writeFileSync(config, JSON.stringify({ mediaDir: media }));
  const log = path.join(tmp, `${name}.ffmpeg.log`);
  writeFileSync(log, "");
  return { dir, config, log };
}

type Run = { status: number | null; stdout: string; stderr: string; ffmpeg: string; dir: string };
function exportFast(name: string, args: string[]): Promise<Run> {
  const m = renderedMatch(name);
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(root, "node_modules", ".bin", "tsx"),
      [path.join(root, "src", "pipeline", "exportFastCli.ts"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          MCSR_CONFIG: m.config,
          FAKE_FFMPEG_LOG: m.log,
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
      resolve({ status, stdout, stderr, ffmpeg: readFileSync(m.log, "utf8"), dir: m.dir });
    });
  });
}
const read = (dir: string, f: string) =>
  existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : null;

// One at a time: the lab has four cores shared with the live dashboard.
const [smoke, final, spaced, garbled] = [
  await exportFast("smoke", [String(ID), "--seconds=2", "--cpu"]),
  await exportFast("final", [`https://mcsrranked.com/matches/${ID}`, "--cpu", "--full-tail"]),
  // The same smoke request typed the other common way, and with a value that is not a number.
  await exportFast("spaced", [String(ID), "--seconds", "2", "--cpu"]),
  await exportFast("garbled", [String(ID), "--seconds=2s", "--cpu"]),
];

/* --- 1-3, 5: the smoke run ------------------------------------------------------------------ */
assert.equal(smoke.status, 0, smoke.stderr);
assert.equal(read(smoke.dir, `smoke-${ID}.mp4`), "ENCODED", "the smoke run lands on smoke-<id>.mp4");
assert.equal(read(smoke.dir, `final-${ID}.mp4`), PUBLISHED, "the published final is untouched");
assert.equal(read(smoke.dir, `final-${ID}.json`), PUBLISHED_RECORD, "and so is its export record");
assert.equal(
  existsSync(path.join(smoke.dir, `smoke-${ID}.part.mp4`)),
  false,
  "the part file is promoted, not left behind",
);
assert.equal(
  existsSync(path.join(smoke.dir, `smoke-${ID}.json`)),
  false,
  "a smoke run writes no record of its own either",
);
assert.match(smoke.ffmpeg, / -t 2\.000 /, "--seconds=2 is two seconds of output");
assert.match(smoke.ffmpeg, /libx264/, "--cpu encodes with libx264");
assert.doesNotMatch(smoke.ffmpeg, /h264_vaapi|vaapi=va/, "--cpu never touches the VAAPI device");
assert.equal(
  JSON.parse(smoke.stdout).outPath,
  path.join(smoke.dir, `smoke-${ID}.mp4`),
  "the JSON result names the smoke file",
);
console.log("OK: --seconds=N writes smoke-<id>.mp4 only; the published final and its record are untouched");

/* --- 4, 6, 7: the real export, by URL ------------------------------------------------------- */
assert.equal(final.status, 0, final.stderr);
assert.equal(read(final.dir, `final-${ID}.mp4`), "ENCODED", "a full export replaces final-<id>.mp4");
assert.deepEqual(
  JSON.parse(read(final.dir, `final-${ID}.json`)!),
  { matchStartSec: 10 },
  "7 s card: match start at 0:10",
);
assert.equal(existsSync(path.join(final.dir, `smoke-${ID}.mp4`)), false, "and writes no smoke file");
assert.match(final.ffmpeg, / -t 600\.000 /, "--full-tail keeps the whole overlay span");
assert.equal(JSON.parse(final.stdout).matchId, ID, "the match page URL named the match");
console.log("OK: without --seconds the export is final-<id>.mp4 with final-<id>.json { matchStartSec: 10 }");

/* --- 1 again, the edges: a --seconds the parser does not read ------------------------------- */
// The incident this rule pins was a smoke run landing on a published final. A run that asks for
// --seconds in another spelling, or with a unit, refuses instead of falling through to a full export.
for (const [r, typed] of [
  [spaced, "--seconds 2"],
  [garbled, "--seconds=2s"],
] as const) {
  assert.equal(r.status, 1, `\`${typed}\` refuses (exit 1)`);
  assert.match(r.stderr, /--seconds needs a positive number/, `\`${typed}\` says why`);
  assert.equal(read(r.dir, `final-${ID}.mp4`), PUBLISHED, `\`${typed}\` leaves the published final alone`);
  assert.equal(read(r.dir, `final-${ID}.json`), PUBLISHED_RECORD, `\`${typed}\` leaves the export record alone`);
  assert.equal(existsSync(path.join(r.dir, `final-${ID}.part.mp4`)), false);
  assert.equal(r.ffmpeg, "", `\`${typed}\` never reaches ffmpeg`);
}
console.log("OK: an unreadable --seconds refuses and never touches the published final");

// Sanity: the stand-ins really were what ran (nothing encoded on the shared lab cores).
assert.ok(statSync(path.join(bin, "ffmpeg")).size < 300);
console.log("exportFastCli.contract: all checks passed");
