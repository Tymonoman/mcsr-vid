// Self-check for agy.ts's answer validator: junk falls back, a good answer passes through
// trimmed and bounded.
// Run: npx tsx src/telegram/agy.test.ts
import assert from "node:assert/strict";
import { validateAgyAnswer } from "./agy.js";

// Junk -> null (the caller's cue to fall back).
assert.equal(validateAgyAnswer(null), null);
assert.equal(validateAgyAnswer("a string, not an object"), null);
assert.equal(validateAgyAnswer([]), null);
assert.equal(validateAgyAnswer({}), null); // no headline, no todo
assert.equal(validateAgyAnswer({ headline: "ok" }), null); // no todo at all
assert.equal(validateAgyAnswer({ headline: "ok", todo: "not an array" }), null);
assert.equal(validateAgyAnswer({ headline: "ok", todo: [] }), null); // empty todo
assert.equal(validateAgyAnswer({ headline: "one\ntwo\nthree", todo: ["x"] }), null); // 3 lines
assert.equal(validateAgyAnswer({ headline: "", todo: ["x"] }), null); // blank headline
assert.equal(validateAgyAnswer({ headline: "x".repeat(400), todo: ["x"] }), null); // absurd headline
assert.equal(validateAgyAnswer({ headline: "ok", todo: ["x"], notes: "not an array" }), null);

// A good answer passes through, trimmed.
{
  const out = validateAgyAnswer({
    headline: "  3 waiting for a hook, 1 upload scheduled today  ",
    todo: ["  save hooks for #12345  ", "check the failed nightly run"],
  });
  assert.deepEqual(out, {
    headline: "3 waiting for a hook, 1 upload scheduled today",
    todo: ["save hooks for #12345", "check the failed nightly run"],
  });
}

// A two-line headline is fine (the limit is more than two).
assert.ok(validateAgyAnswer({ headline: "line one\nline two", todo: ["x"] }));

// Over 8 todo items: kept, but capped at 8.
{
  const out = validateAgyAnswer({ headline: "ok", todo: Array.from({ length: 12 }, (_, i) => `item ${i}`) });
  assert.equal(out?.todo.length, 8);
  assert.equal(out?.todo[0], "item 0");
}

// One bad todo item among good ones is dropped, not a reason to reject the whole answer.
{
  const out = validateAgyAnswer({ headline: "ok", todo: ["good one", 42, "x".repeat(400), "good two"] });
  assert.deepEqual(out?.todo, ["good one", "good two"]);
}

// notes: optional, capped at 3, dropped entirely (not an empty array) when nothing survives.
{
  const out = validateAgyAnswer({ headline: "ok", todo: ["x"], notes: ["a", "b", "c", "d"] });
  assert.deepEqual(out?.notes, ["a", "b", "c"]);
}
{
  const out = validateAgyAnswer({ headline: "ok", todo: ["x"], notes: [42] });
  assert.equal(out?.notes, undefined);
}

console.log("agy: all checks passed");
