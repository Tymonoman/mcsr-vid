import assert from "node:assert/strict";
import { buildTitle, formatTitle, HOOK_PLACEHOLDER } from "./title.js";

// The two nicknames that were actually misspelled on the channel come through exactly as the
// API spells them — that is the whole point of generating this half.
assert.equal(
  buildTitle({ leftNickname: "Feinberg", rightNickname: "Infume" }).generated,
  "Feinberg vs Infume | MCSR Ranked 1v1",
);
assert.equal(
  buildTitle({ leftNickname: "ANJOUU", rightNickname: "silverrruns" }).generated,
  "ANJOUU vs silverrruns | MCSR Ranked 1v1",
);

// Nicknames are passed through verbatim: casing, underscores and repeated letters all survive.
assert.equal(
  buildTitle({ leftNickname: "lowk3y_", rightNickname: "Aquacorde" }).generated,
  "lowk3y_ vs Aquacorde | MCSR Ranked 1v1",
);

const edcr = buildTitle({ leftNickname: "edcr", rightNickname: "doogile" });
assert.equal(edcr.title, "<HOOK> | edcr vs doogile | MCSR Ranked 1v1");
assert.equal(edcr.title.startsWith(HOOK_PLACEHOLDER), true);

// Hook budget for that match: 34 gets the title to 70 characters, 47 is the most that still
// leaves both nicknames inside YouTube's ~50-character mobile cutoff.
assert.equal(edcr.hookMin, 34);
assert.equal(edcr.hookMax, 47);
// The hook actually shipped ("YN vs TAS", 9 chars) was well under — the tool would have said so.
assert.ok("YN vs TAS".length < edcr.hookMin);

// A hook at either end of the budget must satisfy the limit it exists to protect.
for (const len of [edcr.hookMin, edcr.hookMax]) {
  const finished = edcr.title.replace(HOOK_PLACEHOLDER, "x".repeat(len));
  assert.ok(finished.length <= 100, `hook of ${len} overruns the 100-char hard limit`);
  assert.ok(finished.indexOf("edcr") <= 50, `hook of ${len} pushes the names past the mobile cut`);
}
assert.ok(edcr.title.replace(HOOK_PLACEHOLDER, "x".repeat(edcr.hookMin)).length >= 70);

// Budgets stay coherent and non-negative for absurd nicknames, rather than going inverted.
for (const [l, r] of [
  ["a", "b"],
  ["x".repeat(60), "y".repeat(60)],
  ["", ""],
]) {
  const { hookMin, hookMax } = buildTitle({ leftNickname: l, rightNickname: r });
  assert.ok(hookMin >= 0 && hookMax >= 0, "budgets must never go negative");
  assert.ok(hookMin <= hookMax, "the minimum hook must fit inside the maximum");
}

// The file leads with the title on its own line, so line 1 is what gets pasted.
const file = formatTitle(edcr);
assert.equal(file.split("\n")[0], edcr.title);
assert.ok(file.includes("34-47 characters"));

console.log("title: all checks passed");
