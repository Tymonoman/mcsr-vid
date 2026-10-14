// A playoff game's band carries no head-to-head: next to the series dots, "<left> 1 — 0 <right>"
// reads as the series score, which is why the intro card hides it too (Intro.tsx's H2H). Overlay.tsx
// imports overlay.css and cannot load in Node, so this reads the source.
// Run: npx tsx remotion/overlayPlayoffH2h.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const overlay = readFileSync(new URL("./Overlay.tsx", import.meta.url), "utf8");
const guard = overlay.indexOf("props.playoffLabel === undefined && (");
const label = overlay.indexOf('className="h2h-label"');
const value = overlay.indexOf('className="h2h-value"');
assert.ok(label > 0 && value > label, "the band still has its head-to-head");
assert.equal(
  overlay.indexOf('className="h2h-label"', label + 1),
  -1,
  "one head-to-head, not a second ungated copy",
);
assert.ok(guard >= 0 && guard < label, "the head-to-head sits behind the playoff guard");
// Nothing closes the guard between it and the value span.
assert.ok(!overlay.slice(guard, value).includes(")}"), "the guard wraps both the label and the value");

console.log("overlayPlayoffH2h: all checks passed");
