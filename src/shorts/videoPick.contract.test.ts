// Contract test for the pick prompt's past-hook examples and the block list (`pastTitleHooks`,
// src/shorts/videoPick.ts), from the docs alone (CLAUDE.md "Blocked players" and "Shorts" → the
// model's title hooks "from the operator's own past saved hooks as style examples";
// handbook/claude-md-reference.md, same bullets). Promises:
//
//   1. A blocked player's match is "never a past-hook style example" — however it reached the channel
//      before the block, its saved hook is not shown to the model, not even unnamed.
//   2. Any case.
//   3. That holds whatever the operator typed: a typed hook always saves (only < > and newlines are
//      touched), so a hook with its own " | " in it is still that blocked match's hook.
//   4. That holds for a player the title spells the broadcast's way (`titleNames`, title only).
//   5. The control: a clean uploaded match's saved hook is an example.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/shorts/videoPick.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import { pastTitleHooks } from "./videoPick.js";

function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const saved = { mediaDir: config.mediaDir, blocked: config.blockedPlayers, titleNames: config.titleNames };
config.titleNames = { ...DEFAULTS.titleNames };

/** A fresh media dir holding uploaded matches with these saved titles (the operator's edited title). */
const channel = (titles: Record<number, string>): void => {
  config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-pasthooks-contract-"));
  for (const [id, line] of Object.entries(titles)) {
    const dir = path.join(config.mediaDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "youtube.json"), JSON.stringify({ videoId: `v${id}`.padEnd(11, "x") }));
    writeFileSync(path.join(dir, `match-${id}.title.edited.txt`), `${line}\n`);
  }
};
const TAIL = "MCSR Ranked 1v1 | Minecraft Speedrun";
const hooks = () => pastTitleHooks().map((h) => h.hook);

try {
  // --- 1/2/5. A blocked pair's hook is never an example; a clean one is ----------------------------
  config.blockedPlayers = ["aquacorde", "BEEFSALAD"]; // any case
  channel({
    1: `ONE HEART LEFT | BlazeMind vs Aquacorde | ${TAIL}`,
    2: `NO BED, NO PROBLEM | hackingnoises vs BeefSalad | ${TAIL}`,
    3: `WHO BLINKS FIRST? | edcr vs doogile | ${TAIL}`,
  });
  assert.deepEqual(hooks(), ["WHO BLINKS FIRST?"], "only the clean match's hook is shown to the model");
  console.log("OK: a blocked player's saved hook is never a style example; a clean one is");

  // --- 3. A typed hook with its own " | " ----------------------------------------------------------
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  channel({
    4: `ONE HEART | NO BED | BlazeMind vs Aquacorde | ${TAIL}`,
    5: `WHO BLINKS FIRST? | edcr vs doogile | ${TAIL}`,
  });
  const piped = hooks();
  deviation(
    "CLAUDE.md Blocked players: 'never a past-hook style example' (a saved hook containing ' | ')",
    () =>
      assert.deepEqual(
        piped,
        ["WHO BLINKS FIRST?"],
        `examples were ${JSON.stringify(piped)} — the pair is read as the second " | " segment, so a hook with its own " | " hides the blocked pair`,
      ),
  );

  // --- 4. A titleNames spelling ----------------------------------------------------------------------
  config.blockedPlayers = ["Pinne"]; // Pinne is spelled "Skycrab" in titles (titleNames default)
  channel({
    6: `SKY HIGH STAKES | Skycrab vs doogile | ${TAIL}`,
    7: `WHO BLINKS FIRST? | edcr vs doogile | ${TAIL}`,
  });
  const spelled = hooks();
  deviation(
    "CLAUDE.md Blocked players: 'never a past-hook style example' (a player the title spells via titleNames)",
    () =>
      assert.deepEqual(
        spelled,
        ["WHO BLINKS FIRST?"],
        `examples were ${JSON.stringify(spelled)} — the title's "Skycrab" is never mapped back to the blocked "Pinne"`,
      ),
  );
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.titleNames = saved.titleNames;
}

console.log("videoPick.contract: all checks passed");
