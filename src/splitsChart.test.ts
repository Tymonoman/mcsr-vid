/**
 * public/splits.js is a browser file with no module system, so it is probed the only way a Node
 * test can reach it: read it, wrap it, call it. Worth the trick because the compact chart is the
 * one place the drawing rules differ, and "no labels on a card" is invisible to a typechecker.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dirname, "..", "public", "splits.js"), "utf8");
const splitsChart = new Function(`${source}; return splitsChart;`)() as (
  splits: unknown,
  opts: { left: string; right: string; compact?: boolean },
) => string;

const splits = [
  { label: "Nether enter", aMs: 90_000, bMs: 95_000, gapMs: 5_000, leader: "edcr" },
  { label: "Fortress", aMs: 210_000, bMs: 204_000, gapMs: 6_000, leader: "doogile" },
  { label: "Dragon", aMs: 496_000, bMs: null, gapMs: null, leader: null },
];
const opts = { left: "edcr", right: "doogile" };

const compact = splitsChart(splits, { ...opts, compact: true });
assert.ok(compact.startsWith("<svg"), "still draws a chart");
assert.ok(!compact.includes("<text"), "no text at all on a card: at ~300px the labels overlap");
assert.ok(compact.includes("<title>"), "tooltips survive — they are the only labelling left");
assert.ok(compact.includes('viewBox="0 0 1000 60"'), "and the strip is short");
// Two rails, three connectable milestones: the shape is the whole message.
assert.equal(compact.match(/<circle/g)?.length, 6, "5 dots plus the marker for the unreached one");

// The full chart is unchanged: it is the detail page, where the labels fit and are read.
const fullChart = splitsChart(splits, opts);
assert.ok(fullChart.includes('class="sc-tick"'), "milestone labels");
assert.ok(fullChart.includes('class="sc-gap"'), "gap callouts");
assert.ok(fullChart.includes('class="sc-name"'), "player names");
assert.ok(fullChart.includes('viewBox="0 0 1000 168"'));

assert.equal(splitsChart([], opts), "", "nothing comparable to draw");

console.log("splitsChart: ok");
