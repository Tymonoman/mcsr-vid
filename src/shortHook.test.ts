import assert from "node:assert/strict";
import { buildShortDescription, buildShortTitle, resolveShortHook } from "./shortHook.js";
import { HASHTAGS } from "./description.js";
import { buildTitle, HOOK_PLACEHOLDER } from "./title.js";
import { layoutShortHook } from "../remotion/shortHookLayout.js";

/** The tail every Short title carries; kept here so the length assertions can subtract it. */
const TAGS = " #minecraft #mcsr";
const SUGGESTIONS = ["#3 vs #11", "Decided by 2.4 seconds"];
const FALLBACK = "watch the lead flip here";

// --- resolveShortHook: the operator's own title hook outranks everything.
{
  const edited = `The 1974 takes down the 2100 | Aquacorde vs nahhann | MCSR Ranked 1v1`;
  assert.equal(resolveShortHook(edited, SUGGESTIONS, FALLBACK), "The 1974 takes down the 2100");
}
{
  // The file is the paste-and-edit one buildTitle writes: title first, guidance after a blank
  // line. Only the first line is the title, and only the part before the first " | " is the hook.
  const edited = ["WANNABE vs REAL GOAT | a vs b | MCSR Ranked 1v1", "", "Replace <HOOK> with ..."].join(
    "\n",
  );
  assert.equal(resolveShortHook(edited, SUGGESTIONS, FALLBACK), "WANNABE vs REAL GOAT");
}
{
  // A hook may contain a pipe of its own; only the *first* separator ends it.
  assert.equal(resolveShortHook("a | b | c", [], FALLBACK), "a");
}

// --- An unfinished title is not a hook: fall through to the suggestions.
{
  const generated = buildTitle({ leftNickname: "Aquacorde", rightNickname: "nahhann" });
  assert.ok(generated.title.includes(HOOK_PLACEHOLDER), "buildTitle still leaves the placeholder");
  assert.equal(resolveShortHook(generated.title, SUGGESTIONS, FALLBACK), SUGGESTIONS[0]);
}
{
  // No file at all, an empty one, or one whose hook half was cleared but whose separator was
  // left behind — trimming that first line before the split would yield a hook of "| a vs b".
  assert.equal(resolveShortHook(null, SUGGESTIONS, FALLBACK), SUGGESTIONS[0]);
  assert.equal(resolveShortHook("", SUGGESTIONS, FALLBACK), SUGGESTIONS[0]);
  assert.equal(resolveShortHook(" | a vs b | MCSR Ranked 1v1", SUGGESTIONS, FALLBACK), SUGGESTIONS[0]);
}

// --- Only when there is no suggestion either does the moment-derived line render.
{
  assert.equal(resolveShortHook(null, [], FALLBACK), FALLBACK);
  assert.equal(resolveShortHook(`${HOOK_PLACEHOLDER} | a vs b`, [], FALLBACK), FALLBACK);
  assert.equal(resolveShortHook(null, ["", "  "], FALLBACK), FALLBACK);
}

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

// --- The metadata files the manual upload is typed from.
{
  // The hook is the title, verbatim: it is the line already judged good enough to burn in.
  assert.equal(
    buildShortTitle("both blind at the same time"),
    "both blind at the same time #minecraft #mcsr",
  );
  assert.equal(buildShortTitle("  padded  "), "padded #minecraft #mcsr");

  // 100 is YouTube's hard cap, and a title cut mid-word reads as a broken pipeline. Only an
  // edited long-form title can produce a hook this long — the suggestion budget caps at 47.
  const title = buildShortTitle(`${"word ".repeat(30)}end`);
  assert.ok(title.length <= 100, `title ran to ${title.length} characters`);
  assert.ok(title.endsWith(TAGS), "the tags must survive the truncation");
  assert.ok(!title.slice(0, -TAGS.length).endsWith("wor"), "truncated mid-word");
  // A single unbreakable word has no boundary to cut at; it still has to fit.
  assert.ok(buildShortTitle("x".repeat(200)).length <= 100);
}
{
  const description = buildShortDescription(12730175, "edcr", "doogile");
  assert.match(description.split("\n")[0]!, /edcr vs doogile.*MCSR Ranked 1v1/);
  assert.ok(description.includes("https://mcsrranked.com/matches/12730175"));
  // The same three the long-form carries, not a second set — both halves of a match should look
  // like one channel to YouTube.
  assert.ok(description.includes(HASHTAGS.join(" ")));
}

// A rank hook is the common case now, and its hashes would read as hashtags in a title — the
// first three shown above the Short would be "#7 #11 #minecraft". So it gets no appended tags.
assert.equal(buildShortTitle("#7 vs #11"), "#7 vs #11", "hash-bearing hooks must not gain hashtags");
assert.equal(buildShortTitle("WANNABE vs REAL GOAT"), "WANNABE vs REAL GOAT #minecraft #mcsr");
console.log("OK: a rank hook stands alone in the Short title");

console.log("shortHook: all checks passed");
