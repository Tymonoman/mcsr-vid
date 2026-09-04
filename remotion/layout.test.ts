import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  POV_WIDTH,
  POV_HEIGHT,
  TOP_BAND_HEIGHT,
  BOTTOM_BAND_HEIGHT,
  BOTTOM_BAND_Y,
  LEFT_POV_RECT,
  RIGHT_POV_RECT,
  META_COL_WIDTH,
  SPLITS_COL_WIDTH,
  RTA_COL_WIDTH,
  RTA_COL_X,
  STATIC_COL_WIDTH,
} from "./layout.js";

// The stage is 16:9, and so is each half-width POV slot.
assert.equal(STAGE_WIDTH / STAGE_HEIGHT, 16 / 9);
assert.equal(POV_WIDTH / POV_HEIGHT, 16 / 9);
assert.equal(POV_WIDTH, 960);
assert.equal(POV_HEIGHT, 540);

// THE invariant: the transparent gap between the bands is exactly one POV tall. If this fails,
// the overlay is covering gameplay (top HUD / hotbar) or the POVs are letterboxed — the exact
// bug viewers reported on the edcr vs doogile upload.
assert.equal(TOP_BAND_HEIGHT + BOTTOM_BAND_HEIGHT, STAGE_HEIGHT - POV_HEIGHT);
assert.equal(BOTTOM_BAND_Y - TOP_BAND_HEIGHT, POV_HEIGHT);

// Two POVs tile the full stage width with no gutter and no overlap.
assert.equal(POV_WIDTH * 2, STAGE_WIDTH);
assert.equal(LEFT_POV_RECT, "0 194 960 540 1");
assert.equal(RIGHT_POV_RECT, "960 194 960 540 1");

// The CSS carries the same band heights as literal px. They were percentages once, and the
// rounding drift between the two is what let the bands creep over the footage.
const css = readFileSync(new URL("./overlay.source.css", import.meta.url), "utf8");
const px = (selector: string, prop: string) => {
  const block = css.slice(css.indexOf(`\n${selector} {`));
  const m = block.slice(0, block.indexOf("}")).match(new RegExp(`${prop}:\\s*(\\d+)px`));
  assert.ok(m, `${selector} { ${prop} } must be declared in px, not %`);
  return Number(m![1]);
};
assert.equal(px(".row1", "height") + px(".row2", "height"), TOP_BAND_HEIGHT);
assert.equal(px(".row2", "top"), px(".row1", "height"));
assert.equal(px(".splits", "height"), BOTTOM_BAND_HEIGHT);

// The bottom band splits into a static region and the RTA column, rendered as two separate
// crops of the same stage and butted back together on the timeline. If these stop tiling the
// band exactly, the overlay gains a seam or a doubled strip — so pin the arithmetic, and pin
// the CSS to it, the same way the band heights are pinned above.
assert.equal(META_COL_WIDTH + SPLITS_COL_WIDTH + RTA_COL_WIDTH, STAGE_WIDTH);
assert.equal(RTA_COL_X, META_COL_WIDTH + SPLITS_COL_WIDTH);
assert.equal(STATIC_COL_WIDTH + RTA_COL_WIDTH, STAGE_WIDTH);

// The columns must be fixed px, not percentages: as flex items with a percentage basis they
// shrank to fit overlong content (a 16-character nickname in the head-to-head line does it),
// which silently moved the crop seam away from RTA_COL_X.
const flexBasis = (selector: string) => {
  const block = css.slice(css.indexOf(`\n${selector} {`));
  const m = block.slice(0, block.indexOf("}")).match(/flex:\s*0\s+0\s+(\d+)px/);
  assert.ok(m, `${selector} must declare a fixed px flex basis, not a percentage width`);
  return Number(m![1]);
};
assert.equal(flexBasis(".col-meta"), META_COL_WIDTH);
assert.equal(flexBasis(".col-splits"), SPLITS_COL_WIDTH);
assert.equal(flexBasis(".col-rta"), RTA_COL_WIDTH);

console.log("layout invariants ok");
