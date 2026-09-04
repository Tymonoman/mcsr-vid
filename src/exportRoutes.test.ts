import assert from "node:assert/strict";
import path from "node:path";
import { relocateRoot } from "./exportRoutes.js";

// A project cut on the desktop names a desktop path. The lab has the same match under a
// different absolute path, so the upload route rewrites this one attribute; if that regex is
// wrong, every clip is offline and you find out an hour into an encode.

// Kdenlive's own save puts root in the middle of the attribute list, not first.
const kdenliveSaved =
  `<?xml version='1.0' encoding='utf-8'?>\n` +
  `<mlt LC_NUMERIC="C" producer="main_bin" root="/home/tymek/Documents/code/mcsr-vid/media/12296170" version="7.40.0">\n` +
  `  <chain id="chain0"><property name="resource">lowk3y_.mp4</property></chain>\n` +
  `</mlt>\n`;

const moved = relocateRoot(kdenliveSaved, "/media/12296170");
assert.match(moved, /root="\/media\/12296170"/, "root must be rewritten wherever it sits");
assert.ok(
  !moved.includes("/home/tymek/"),
  "no desktop path may survive the rewrite — that is the whole point",
);
assert.match(moved, /LC_NUMERIC="C"/, "sibling attributes must be left alone");
assert.match(moved, /version="7.40.0"/, "sibling attributes must be left alone");
assert.match(moved, /resource">lowk3y_\.mp4</, "relative resources must be untouched");

// Our own generator emits root first. Both orderings have to work.
const generated = `<mlt root="/media/1" LC_NUMERIC="en_US.UTF-8" producer="main_bin" version="7.25.0">`;
assert.equal(
  relocateRoot(generated, "/media/2"),
  `<mlt root="/media/2" LC_NUMERIC="en_US.UTF-8" producer="main_bin" version="7.25.0">`,
);

// Only the <mlt> tag's own root is a location. A property that merely contains the word must
// not be rewritten, or the rewrite corrupts the timeline instead of relocating it.
const decoy =
  `<mlt root="/a" producer="main_bin">\n` +
  `  <property name="kdenlive:docproperties.rooturl">/a/keep-me</property>\n` +
  `</mlt>`;
const decoyMoved = relocateRoot(decoy, "/b");
assert.match(decoyMoved, /<mlt root="\/b"/, "the mlt root is rewritten");
assert.match(decoyMoved, /rooturl">\/a\/keep-me</, "a property that just mentions root is not");

// A project with no root at all (an older generated one) must pass through rather than throw.
const rootless = `<mlt LC_NUMERIC="C" producer="main_bin" version="7.25.0">`;
assert.equal(relocateRoot(rootless, "/media/9"), rootless, "no root: unchanged, not corrupted");

// The route resolves the match dir before rewriting, because config.mediaDir is relative on a
// desktop checkout ("media") and absolute on the lab ("/media"). A relative root resolves
// against whatever cwd melt happens to have — which is a project that opens with every clip
// offline. Caught by a smoke test that wrote root="media/12296170" into a real project.
const relative = relocateRoot(generated, path.resolve("media/12296170"));
assert.match(relative, /root="\/.*\/media\/12296170"/, "root written into a project must be absolute");

console.log("exportRoutes: all checks passed");
