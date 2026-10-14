/**
 * `npm run config:example` (scripts/write-config-example.mts), tested from the docs alone —
 * CLAUDE.md Commands ("Rewrites mcsr-vid.config.example.json from DEFAULTS. Run after adding a
 * config key") and handbook/claude-md-reference.md l.76 ("so the example cannot drift (it had, by
 * seven keys)").
 *
 * The promises, as the docs make them:
 *  E1  Run anywhere, the script writes, byte for byte, the example committed at the repo root —
 *      i.e. the committed example has not drifted from DEFAULTS since someone last added a key.
 *  E2  The example holds every Config key, in DEFAULTS' order, each at its default; the one value
 *      that is not a default is reasonerCommand, shown as the lab's argv (LAB_REASONER_COMMAND).
 *  E3  Copied as a box's mcsr-vid.config.json, the example boots (the loader's own validateOverrides
 *      passes) and leaves the three Settings-tab-proof switches off.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const committedText = readFileSync(path.join(root, "mcsr-vid.config.example.json"), "utf8");
const committed = JSON.parse(committedText) as Record<string, unknown>;
const { DEFAULTS, LAB_REASONER_COMMAND, validateOverrides } = await import("../src/config.js");

// --- E1: the script reproduces the committed file -------------------------------------------------
{
  // watchScript's default lives under the home directory of whoever ran the script; run it with
  // that same HOME so the comparison is byte for byte on any machine, CI included.
  const watchScript = String(committed.watchScript);
  const at = watchScript.indexOf("/.claude/");
  assert.ok(at > 0, "the committed watchScript is under a home directory");
  const scratch = mkdtempSync(path.join(tmpdir(), "mcsr-config-example-"));
  const run = spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "scripts", "write-config-example.mts")],
    {
      cwd: scratch,
      env: { ...process.env, HOME: watchScript.slice(0, at) },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(run.status, 0, `the script ran: ${run.stderr}`);
  const written = readFileSync(path.join(scratch, "mcsr-vid.config.example.json"), "utf8");
  // A drifted example is the bug this script exists to make impossible (seven keys, 22 Sept 2026).
  assert.equal(written, committedText, "npm run config:example would change the committed example");
  rmSync(scratch, { recursive: true, force: true });
  console.log("write-config-example.contract: the committed example is what the script writes");
}

// --- E2: every key, at its default, in order ------------------------------------------------------
assert.deepEqual(Object.keys(committed), Object.keys(DEFAULTS), "every Config key, in DEFAULTS' order");
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (key === "reasonerCommand") {
    assert.deepEqual(committed[key], LAB_REASONER_COMMAND, "the example shows the lab's reasoner argv");
  } else if (key === "watchScript") {
    // The same path, relative to whichever home directory it was generated under.
    assert.ok(String(committed[key]).endsWith(String(value).slice(String(value).indexOf("/.claude/"))));
  } else {
    assert.deepEqual(committed[key], value, `${key} in the example is its default`);
  }
}
console.log("write-config-example.contract: the example is DEFAULTS plus the lab's reasoner");

// --- E3: copying it as a config is safe ----------------------------------------------------------
assert.doesNotThrow(() => validateOverrides(committed), "the example boots as a config file");
assert.equal(committed.youtubeUploadEnabled, false);
assert.equal(committed.nightlyUpload, "off");
assert.equal(committed.studioAutomation, false);
console.log("write-config-example.contract: all checks passed");
