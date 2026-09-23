import assert from "node:assert/strict";
import { buildShortDescription, buildShortTitle, endCardText } from "./shortHook.js";
import { HASHTAGS } from "../pipeline/description.js";
import { layoutShortHook } from "../../remotion/shortHookLayout.js";

// --- layoutShortHook: never more than two lines, never wider than the board.
{
  // 1080 wide, less the 24px box inset and the ~22px the outline and crimson drop reach past
  // the last glyph, at Monocraft's 0.682em advance.
  const fits = (l: { lines: string[]; fontSize: number }) =>
    Math.max(...l.lines.map((s) => s.length)) * l.fontSize * 0.682 <= 1080 - 2 * (24 + 22);

  const short = layoutShortHook("#3 vs #11");
  assert.deepEqual(short, { lines: ["#3 vs #11"], fontSize: 120 }, "a short hook gets the top step");

  for (const text of [
    "both of them die at the same time",
    "Decided by 2.4 seconds",
    "Rematch: Aquacorde leads 3-1",
    "One of them never reached the dragon",
    // The longest the title budget can hand over (hookMax caps at 47).
    "x".repeat(47),
    "aaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbb",
  ]) {
    const layout = layoutShortHook(text);
    assert.ok(layout.lines.length <= 2, `${text}: wrapped to ${layout.lines.length} lines`);
    assert.equal(layout.lines.join(" ").replace(/\s+/g, " "), text.trim());
    assert.ok(fits(layout), `${text}: ${layout.fontSize}px overflows the board`);
    assert.ok(layout.fontSize <= 120, `${text}: ${layout.fontSize}px is past the top step`);
  }
}

// --- The Short's title (decision 12, 23 Sept 2026): hook | both names as the long title spells
// them, then the tags while the whole fits YouTube's 100.
{
  assert.equal(
    buildShortTitle("both blind at the same time", "doogile", "Feinberg"),
    "both blind at the same time | doogile vs Feinberg #mcsr #minecraft",
  );
  // titleName: Pinne is Skycrab on every title, the Short's included.
  assert.equal(buildShortTitle("  padded  ", "Pinne", "lowk3y_"), "padded | Skycrab vs lowkey #mcsr #minecraft");
  // The tags go first when the whole would pass 100; the hook and the names never are cut.
  const long = "x".repeat(70);
  assert.equal(buildShortTitle(long, "doogile", "Feinberg"), `${long} | doogile vs Feinberg`);
  assert.ok(buildShortTitle("x".repeat(65), "doogile", "Feinberg").length <= 100);
}
{
  const description = buildShortDescription(12730175, "edcr", "doogile");
  // The same voice as the long-form description: what it is, in a sentence a person would type.
  assert.equal(
    description.split("\n")[0],
    "edcr vs doogile, mcsr ranked 1v1. the whole match is on the channel with both streams side by side.",
  );
  assert.ok(description.includes("match page: https://magmamcsr.com/ranked/player/edcr/matches/12730175"));
  // The same three the long-form carries, not a second set — both halves of a match should look
  // like one channel to YouTube.
  assert.ok(description.includes(HASHTAGS.join(" ")));
  assert.ok(!description.includes("all the matches"), "no playlist line until the URL is configured");
  const url = "https://www.youtube.com/playlist?list=PLHG-jSA-dWDo";
  assert.equal(
    buildShortDescription(12730175, "edcr", "doogile", url).split("\n")[1],
    `all the matches: ${url}`,
    "the playlist link sits on line two, above the match page",
  );
  const tip = buildShortDescription(12730175, "edcr", "doogile", url, "https://ko-fi.com/x").split("\n");
  assert.equal(
    tip[3],
    "tip jar: https://ko-fi.com/x",
    "the tip jar sits under the match page, above the hashtags",
  );
  assert.ok(tip[4]!.startsWith("#"), "hashtags stay last");
  for (const slop of ["synced", "dual-POV", "Full ", " — "]) {
    assert.ok(!tip.join("\n").includes(slop), `"${slop}" must be gone from the Short description`);
  }
}

// --- The closing card (decision 13): a question only when the window stops before the result.
assert.equal(endCardText(true, false), "WHO TOOK IT? FULL MATCH ON THE CHANNEL");
assert.equal(endCardText(false, false), "FULL MATCH ON THE CHANNEL");
assert.equal(endCardText(true, true), "WHO TOOK IT? FULL SERIES ON THE CHANNEL");
assert.equal(endCardText(false, true), "FULL SERIES ON THE CHANNEL");

console.log("shortHook: all checks passed");
