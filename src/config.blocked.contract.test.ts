// Contract test for the block list's one shared check (`isBlockedPlayer`/`blockedIn`, src/config.ts),
// written from the docs alone (CLAUDE.md "Blocked players"; handbook/claude-md-reference.md, same
// bullet). What the docs promise, as an outside reader takes them — every gate in the other
// *.contract.test.ts files leans on these:
//
//   1. `blockedPlayers` defaults to ["Aquacorde", "BeefSalad"] (Aquacorde 2 Oct 2026, BeefSalad 4 Oct 2026).
//   2. The comparison is whole-string: a prefix, a suffix or a name inside another name is not a match.
//   3. The comparison ignores case, on both sides (the list's spelling and the player's).
//   4. `blockedIn` is true when either player is blocked, false for an empty pair, and an empty list
//      blocks nobody.
//   5. A Settings change applies live: the check reads the current config, not a copy taken at import.
//   6. The list is a Settings-tab key, validated like any other override (an array of names).
// Run: MCSR_CONFIG=/nonexistent npx tsx src/config.blocked.contract.test.ts
import assert from "node:assert/strict";
import { blockedIn, config, DEFAULTS, isBlockedPlayer, validateOverrides } from "./config.js";

const saved = config.blockedPlayers;
try {
  // 1. The defaults are the two runners who said no, by name.
  assert.deepEqual(DEFAULTS.blockedPlayers, ["Aquacorde", "BeefSalad"], "the documented default list");
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  assert.ok(isBlockedPlayer("Aquacorde") && isBlockedPlayer("BeefSalad"), "both defaults block");

  // 2. Whole-string: these are other runners, not the blocked one, and must never lose their videos.
  for (const other of [
    "Aquacorde_",
    "xAquacorde",
    "Aqua",
    "corde",
    "BeefSaladx",
    "Beef",
    "Beef Salad",
    "Aquacorde2",
  ])
    assert.equal(isBlockedPlayer(other), false, `"${other}" is a different name — whole-string only`);
  // Regex-looking characters in a listed name are literal: a list entry is not a pattern.
  config.blockedPlayers = ["a.b"];
  assert.equal(isBlockedPlayer("axb"), false, "a list entry is compared as text, never as a pattern");
  assert.equal(isBlockedPlayer("A.B"), true, "and the literal name, any case, is blocked");

  // 3. Case is ignored, whichever side carries it: the API, a filename or a hand-typed list.
  config.blockedPlayers = ["aquacorde", "BEEFSALAD"];
  for (const spelt of ["Aquacorde", "AQUACORDE", "aQuAcOrDe", "beefsalad", "BeefSalad"])
    assert.equal(isBlockedPlayer(spelt), true, `"${spelt}" is the same runner in another case`);

  // 4. Either seat; nothing for nobody.
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  assert.equal(blockedIn(["doogile", "aquacorde"]), true, "the right seat");
  assert.equal(blockedIn(["BEEFSALAD", "doogile"]), true, "the left seat");
  assert.equal(blockedIn(["doogile", "Feinberg"]), false, "neither seat");
  assert.equal(blockedIn([]), false, "no players, nobody blocked");
  config.blockedPlayers = [];
  assert.equal(blockedIn(["Aquacorde", "BeefSalad"]), false, "an empty list blocks nobody");

  // 5. Live: a runner blocked in Settings is blocked on the very next check (no restart).
  config.blockedPlayers = [];
  assert.equal(isBlockedPlayer("silverrruns"), false);
  config.blockedPlayers = ["silverrruns"];
  assert.equal(isBlockedPlayer("silverrruns"), true, "the next call reads the new list");
  config.blockedPlayers = [];
  assert.equal(isBlockedPlayer("silverrruns"), false, "and unblocking applies the same way");

  // 6. It is a Settings key: an array of names validates, anything else is refused by name.
  assert.doesNotThrow(() => validateOverrides({ blockedPlayers: ["Aquacorde", "someone"] }));
  assert.throws(() => validateOverrides({ blockedPlayers: "Aquacorde" }), /blockedPlayers/);
} finally {
  config.blockedPlayers = saved;
}

console.log("config.blocked.contract: all checks passed");
