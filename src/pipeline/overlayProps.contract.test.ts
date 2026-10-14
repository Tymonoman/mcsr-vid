// Contract tests for the overlay-state props (the pure parts of src/pipeline/overlayProps.ts) and
// the settings that drive them, from CLAUDE.md "What the render produces" and
// handbook/claude-md-reference.md. Promises of the list at the top of splitStates.contract.test.ts:
//
//  P3  `ctaReason` is one row of at most 24 plain-ASCII characters above SUBSCRIBE; empty is the
//      bare card.
//  P4  The COMING UP card from `teaserAtSec` (default 10) for `teaserSec` (5); empty is none.
//  P10 "Explain the moves" is off by default (`explainMovesSec` null).
//  P13 `introSec` is 2–7, default 7 (its effect on the MP4 is in exportFast.contract.test.ts).
//  P15 The countdown teaser is off by default.
//
// Runs on DEFAULTS (MCSR_CONFIG points at a missing file), as the nightly would on a fresh box.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { CTA_REASON_MAX_CHARS, DEFAULTS, config, validateOverrides } from "../config.js";
import { chooseMoves } from "./explainMoves.js";
import { ctaReasonProp, explainMovesProp, teaserProp } from "./overlayProps.js";
import { chooseTeaser } from "./teaser.js";

globalThis.fetch = (async () => {
  throw new Error("an overlay-state prop reached for the network");
}) as typeof fetch;

const fixtures = readdirSync(new URL("../fixtures/", import.meta.url))
  .filter((f) => /^match-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8")) as MatchInfo);

/** Runs `fn` with config keys set, and puts them back whatever happens. */
function withConfig(patch: Partial<typeof config>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k as keyof typeof config]]));
  Object.assign(config, patch);
  try {
    fn();
  } finally {
    Object.assign(config, saved);
  }
}

// --- the defaults the docs name ------------------------------------------------------------------
assert.equal(config.teaserAtSec, 10, "P4: the teaser at 10 s by default");
assert.equal(config.teaserSec, 5, "P4: for 5 s");
assert.equal(
  config.explainMovesSec,
  null,
  "P10: explain-the-moves off — on changes what the nightly renders",
);
assert.equal(config.countdownTeaser, false, "P15: the countdown teaser off by default");
assert.equal(config.introSec, 7, "P13: a 7 s intro card by default");
assert.equal(config.postRollCta, true, "P2: the subscribe card on by default");

// --- P13: introSec is 2 to 7, both ends included -------------------------------------------------
for (const ok of [2, 3, 7]) assert.doesNotThrow(() => validateOverrides({ introSec: ok }), `introSec ${ok}`);
// Just outside either end — config.test.ts checks 1 and 8, the edges are what a typo hits.
for (const bad of [1.9, 7.1, Number.NaN])
  assert.throws(() => validateOverrides({ introSec: bad }), /introSec/);

// --- P3: whatever Settings accepts, the card gets one row of ≤24 plain ASCII, or the bare card ----
{
  assert.equal(CTA_REASON_MAX_CHARS, 24);
  const W = (n: number) => "W".repeat(n);
  const candidates = [
    "",
    " ",
    "   \t ",
    DEFAULTS.ctaReason,
    W(24),
    W(25),
    `  ${W(24)}  `,
    `  ${W(25)}  `,
    "ONE ROW\nNOT TWO",
    "NOWY MECZ CO DZIEŃ",
    "NEW MATCH",
    "EVERY DAY 🔥",
    "a new match every day",
  ];
  let accepted = 0;
  for (const value of candidates) {
    let valid = true;
    try {
      validateOverrides({ ctaReason: value });
    } catch {
      valid = false;
    }
    if (!valid) continue;
    accepted++;
    withConfig({ ctaReason: value }, () => {
      const prop = ctaReasonProp();
      if (value.trim() === "") {
        // Empty is the bare card: no reason prop at all, so the card is the one shipped before.
        assert.deepEqual(prop, {}, `${JSON.stringify(value)} is the bare card`);
        return;
      }
      const shown = prop.ctaReason!;
      // One row of the meta column: the post-roll card sits under the final time with no room.
      assert.ok(shown.length <= 24, `${JSON.stringify(value)} reaches the card as ${shown.length} chars`);
      // Plain ASCII: anything else falls back to another font and can overflow the row.
      assert.match(shown, /^[\x20-\x7e]+$/, `${JSON.stringify(value)} reaches the card as non-ASCII`);
    });
  }
  // The checks above ran on real accepted values, and the over-long / non-ASCII ones were refused.
  assert.ok(accepted >= 6, `${accepted} candidates accepted`);
  for (const bad of [
    W(25),
    `  ${W(25)}  `,
    "ONE ROW\nNOT TWO",
    "NOWY MECZ CO DZIEŃ",
    "NEW MATCH",
    "EVERY DAY 🔥",
  ])
    assert.throws(() => validateOverrides({ ctaReason: bad }), /ctaReason/, JSON.stringify(bad));
  // Under DEFAULTS the card carries the default reason.
  assert.deepEqual(ctaReasonProp(), { ctaReason: DEFAULTS.ctaReason });
}

// --- P4: the teaser prop, on every real match ------------------------------------------------------
for (const m of fixtures) {
  const t = chooseTeaser(m);
  // The default timing around teaser.ts's moment; nothing at all when the match has none.
  assert.deepEqual(teaserProp(m), t ? { teaser: { atSec: 10, forSec: 5, ...t } } : {}, `${m.id}`);
  // Empty (null) is none, whatever the match holds.
  withConfig({ teaserAtSec: null }, () => assert.deepEqual(teaserProp(m), {}, `${m.id}: switched off`));
}
assert.ok(
  fixtures.some((m) => chooseTeaser(m) !== null),
  "some fixture has a moment to promise",
);

// --- P10: explain-the-moves, off by default and on when set ---------------------------------------
for (const m of fixtures) {
  assert.deepEqual(explainMovesProp(m), {}, `${m.id}: no cards by default`);
  withConfig({ explainMovesSec: 6 }, () =>
    assert.deepEqual(
      explainMovesProp(m),
      { explainMoves: { forSec: 6, moves: chooseMoves(m) } },
      `${m.id}: on`,
    ),
  );
}

console.log("overlayProps.contract: all checks passed");
