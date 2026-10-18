// Contract tests for the config loader (src/config.ts) and `npm run config:example`
// (scripts/write-config-example.mts) — written from CLAUDE.md first, as an outside engineer.
//
// Promises the docs make:
//  1. `npm run test:unit` runs on DEFAULTS (MCSR_CONFIG points at a missing file), "so a
//     Settings-tab switch can't break it" — no file means config is DEFAULTS, key for key.
//  2. `MCSR_CONFIG` names the overrides file the loader reads.
//  3. An overrides file is merged over DEFAULTS: a key it sets wins, every other key keeps its
//     default (README: `cp mcsr-vid.config.example.json mcsr-vid.config.json # optional: any
//     subset of keys`).
//  4. A hand-edited file with a wrong type fails at load, naming the key (handbook, Settings tab:
//     "validated through validateOverrides"); a file that is not a JSON object is refused too.
//  5. Every match's working directory is `<mediaDir>/<id>` (Layout; NAS: `clips/` is skipped by
//     every `/^\d+$/` scan because match directories are bare ids).
//  6. `npm run config:example` rewrites `mcsr-vid.config.example.json` from DEFAULTS — every key,
//     nothing else, "so the example cannot drift" (it had, by seven keys); the one non-default
//     value is the lab's reasonerCommand.
//  7. The committed example is in step with DEFAULTS today.
//  8. The defaults CLAUDE.md states for keys that config.test.ts does not already pin: postRollSec
//     30, povAudioPan 0.7, teaserAtSec 10 / teaserSec 5, midRollCtaAtSec 90 / midRollCtaSec 4,
//     nightlyRenderHourUtc 3, publishHourUtc 19 / seriesPublishHourUtc 23 / seriesPairGapDays 3,
//     suggestKnownSlots 4, rivalChannelHandle [mcsrmatches, mcsr-vault], titleNames, telegramReportHourWarsaw 7,
//     and the switches documented as off by default (shortsByHand, thumbnailRotatePoses,
//     exportUpscale1440, countdownTeaser, learnedDraw, recordPaceBoostSec, creatorWatch with an
//     empty watchlist) — playoffsFirst is **on** by default since 18 Oct 2026.
//
// Hermetic: the loader is exercised in child processes with temp MCSR_CONFIG files; the example
// script runs in a temp cwd. Run: npx tsx src/config.contract.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, CONFIG_PATH, DEFAULTS, LAB_REASONER_COMMAND, matchDir } from "./config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "mcsr-config-contract-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const tsx = path.join(root, "node_modules", ".bin", "tsx");

type Run = { status: number | null; stdout: string; stderr: string };
function run(args: string[], env: Record<string, string>, cwd = root): Promise<Run> {
  return new Promise((resolve) => {
    const proc = spawn(tsx, args, {
      cwd,
      env: { ...process.env, ...env },
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

/* --- 1, 2, 5 in process --------------------------------------------------------------------- */
if (process.env.MCSR_CONFIG) {
  // Promise 2: the env var is the file, resolved to an absolute path.
  assert.equal(CONFIG_PATH, path.resolve(process.env.MCSR_CONFIG));
}
if (!existsSync(CONFIG_PATH)) {
  // Promise 1: not just "a copy" (config.test.ts pins that) — the same values, every key.
  assert.deepEqual(config, DEFAULTS, "with no overrides file, config is DEFAULTS key for key");
  console.log("OK: a missing overrides file means config is DEFAULTS");
}
// Promise 5.
assert.equal(matchDir(12730175), path.join(config.mediaDir, "12730175"));
assert.match(
  path.basename(matchDir(12730175)),
  /^\d+$/,
  "a match directory is the bare id, so /^\\d+$/ scans find it",
);

/* --- 8: the documented defaults ------------------------------------------------------------- */
const documented: Partial<Record<keyof typeof DEFAULTS, unknown>> = {
  postRollSec: 30, // House rules: tail ≤ postRollSec = 30s
  povAudioPan: 0.7, // House rules: default 0.7
  teaserAtSec: 10, // COMING UP card: default 10
  teaserSec: 5, // for teaserSec (5)
  midRollCtaAtSec: 90, // Hook chips: default 90
  midRollCtaSec: 4, // SUBSCRIBE for midRollCtaSec (4)s
  nightlyRenderHourUtc: 3, // Nightly: default 3 UTC
  publishHourUtc: 19, // 19:00 UTC ranked
  seriesPublishHourUtc: 23, // 23:00 series
  seriesPairGapDays: 3, // seriesPairGapDays 3 apart
  suggestKnownSlots: 4, // suggestKnownSlots, default 4
  rivalChannelHandle: ["mcsrmatches", "mcsr-vault"], // Rival posts default
  titleNames: { Pinne: "Skycrab", lowk3y_: "lowkey" }, // titleNames default
  runnerNicknames: {}, // runnerNicknames default: empty until the operator fills it in
  telegramReportHourWarsaw: 7, // the 07:00 Warsaw schedule
  shortsByHand: false, // default **off**
  playoffsFirst: true, // default **true** since 18 Oct 2026
  thumbnailRotatePoses: false, // default off
  exportUpscale1440: false, // default off
  countdownTeaser: false, // default off
  learnedDraw: false, // default **off**
  recordPaceBoostSec: null, // default **off**
  creatorWatch: false, // off/empty by default
  creatorWatchlist: [],
  postRollCta: true, // the last split state is the subscribe card
};
for (const [key, want] of Object.entries(documented)) {
  assert.deepEqual(DEFAULTS[key as keyof typeof DEFAULTS], want, `CLAUDE.md's default for ${key}`);
}
console.log(`OK: ${Object.keys(documented).length} documented defaults hold`);

/* --- 3, 4: the loader, in child processes --------------------------------------------------- */
const probe = path.join(tmp, "probe.mts");
writeFileSync(
  probe,
  `import { config, matchDir, CONFIG_PATH } from ${JSON.stringify(path.join(root, "src", "config.ts"))};
console.log(JSON.stringify({ config, dir: matchDir(42), path: CONFIG_PATH }));
`,
);
const file = (name: string, body: string) => {
  const p = path.join(tmp, name);
  writeFileSync(p, body);
  return p;
};
const media = path.join(tmp, "media");
const goodPath = file(
  "good.json",
  JSON.stringify({
    mediaDir: media,
    postRollSec: 20,
    shortsByHand: true,
    suggestWeights: { closeMargin: 9 },
  }),
);
// One at a time: the lab has four cores shared with the live dashboard.
const [good, badType, notObject, typo, oneRival, noRival] = [
  await run([probe], { MCSR_CONFIG: goodPath }),
  await run([probe], { MCSR_CONFIG: file("bad-type.json", JSON.stringify({ postRollSec: "30" })) }),
  await run([probe], { MCSR_CONFIG: file("array.json", "[]") }),
  await run([probe], { MCSR_CONFIG: file("typo.json", JSON.stringify({ blockedPlayer: [] })) }),
  await run([probe], {
    MCSR_CONFIG: file("one-rival.json", JSON.stringify({ rivalChannelHandle: "mcsrmatches" })),
  }),
  await run([probe], { MCSR_CONFIG: file("no-rival.json", JSON.stringify({ rivalChannelHandle: "" })) }),
];

// Promise 3: the keys it sets win, every other key is the default — including the other weights
// of a partly overridden suggestWeights (a shallow spread would drop them).
assert.equal(good.status, 0, good.stderr);
const loaded = JSON.parse(good.stdout) as { config: typeof DEFAULTS; dir: string; path: string };
assert.equal(loaded.path, goodPath, "MCSR_CONFIG is the file read");
assert.equal(loaded.config.postRollSec, 20);
assert.equal(loaded.config.shortsByHand, true);
assert.equal(loaded.config.mediaDir, media);
assert.equal(loaded.dir, path.join(media, "42"), "matchDir follows the overridden mediaDir");
assert.equal(loaded.config.suggestWeights.closeMargin, 9);
const { closeMargin: _set, ...otherWeights } = DEFAULTS.suggestWeights;
for (const [k, v] of Object.entries(otherWeights)) {
  assert.equal(
    loaded.config.suggestWeights[k as keyof typeof otherWeights],
    v,
    `weight ${k} keeps its default`,
  );
}
const untouched = Object.keys(DEFAULTS).filter(
  (k) => !["postRollSec", "shortsByHand", "mediaDir", "suggestWeights"].includes(k),
) as (keyof typeof DEFAULTS)[];
for (const k of untouched) {
  assert.deepEqual(loaded.config[k], JSON.parse(JSON.stringify(DEFAULTS[k])), `${k} keeps its default`);
}
console.log("OK: an overrides file is merged over DEFAULTS, key by key");

// The rivals became a list on 16 Oct 2026: an older file's single handle is a list of one, its "" none.
assert.equal(oneRival.status, 0, oneRival.stderr);
assert.deepEqual((JSON.parse(oneRival.stdout) as typeof loaded).config.rivalChannelHandle, ["mcsrmatches"]);
assert.equal(noRival.status, 0, noRival.stderr);
assert.deepEqual((JSON.parse(noRival.stdout) as typeof loaded).config.rivalChannelHandle, []);
console.log('OK: an older file\'s single rival handle loads as a list of one, and "" as none');

// Promise 4: refused at load, naming the key / the shape, not carried into a render.
assert.notEqual(badType.status, 0, "a string where a number belongs fails the load");
assert.match(badType.stderr, /"postRollSec" must be a number/);
assert.equal(badType.stdout, "", "nothing ran on the bad config");
assert.notEqual(notObject.status, 0, "a JSON array is not an overrides file");
assert.match(notObject.stderr, /expected a JSON object/);
assert.notEqual(
  typo.status,
  0,
  "a misspelled key (blockedPlayer for blockedPlayers) is not silently ignored",
);
assert.match(typo.stderr, /unknown key "blockedPlayer"/);
console.log("OK: a wrong type, a non-object and a typo each fail the load, naming the problem");

/* --- 6, 7: npm run config:example ------------------------------------------------------------ */
const cwd = mkdtempSync(path.join(tmpdir(), "mcsr-config-example-"));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
const example = await run(
  [path.join(root, "scripts", "write-config-example.mts")],
  { MCSR_CONFIG: path.join(cwd, "none.json") },
  cwd,
);
assert.equal(example.status, 0, example.stderr);
const written = readFileSync(path.join(cwd, "mcsr-vid.config.example.json"), "utf8");
assert.ok(written.endsWith("}\n"), "one trailing newline, so a rewrite is a clean diff");
const parsed = JSON.parse(written) as Record<string, unknown>;
const expected = JSON.parse(JSON.stringify({ ...DEFAULTS, reasonerCommand: LAB_REASONER_COMMAND })) as Record<
  string,
  unknown
>;
assert.deepEqual(
  Object.keys(parsed),
  Object.keys(expected),
  "every DEFAULTS key, in DEFAULTS' order, nothing else",
);
assert.deepEqual(parsed, expected, "every value is the default, bar the lab's reasonerCommand");
assert.match(example.stdout, new RegExp(`${Object.keys(expected).length} keys`), "it reports the key count");
console.log(`OK: config:example writes all ${Object.keys(expected).length} DEFAULTS keys`);

// Promise 7: the committed example matches. watchScript is the one default built from the
// machine's home directory, so only its repo-relative tail is compared.
const committed = JSON.parse(readFileSync(path.join(root, "mcsr-vid.config.example.json"), "utf8")) as Record<
  string,
  unknown
>;
assert.deepEqual(
  Object.keys(committed),
  Object.keys(expected),
  "the committed example has every key (it once lacked seven)",
);
for (const k of Object.keys(expected)) {
  if (k === "watchScript") {
    assert.ok(
      String(committed[k]).endsWith(".claude/plugins/cache/claude-watch/watch/0.2.0/scripts/watch.py"),
    );
    continue;
  }
  assert.deepEqual(committed[k], expected[k], `committed example's ${k} is the default`);
}
console.log("OK: the committed mcsr-vid.config.example.json is in step with DEFAULTS");

console.log("config.contract: all checks passed");
