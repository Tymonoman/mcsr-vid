import assert from "node:assert/strict";
import type { ChatMessage } from "../src/twitchChat.js";
import { chatCharsPerLine, chatMaxLines, readableColor, visibleMessages } from "./chatPanelLayout.js";

const msg = (atSec: number, name: string, text: string, color: string | null = null): ChatMessage => ({
  atSec,
  name,
  color,
  text,
});

const feed: ChatMessage[] = [msg(5, "a", "gl"), msg(10, "b", "let's go"), msg(20, "c", "nether enter")];

// Nothing is on screen before the first message lands — an empty panel, not the whole feed.
assert.deepEqual(visibleMessages(feed, 0, 10, 30), []);
assert.deepEqual(visibleMessages(feed, 4.9, 10, 30), []);
assert.equal(visibleMessages(feed, 5, 10, 30).length, 1);

// Newest last: chat reads top-down, so the bottom line is the most recent thing said.
assert.deepEqual(
  visibleMessages(feed, 25, 10, 30).map((m) => m.name),
  ["a", "b", "c"],
);

// The cap is on *lines*, not messages, and it drops the oldest.
assert.deepEqual(
  visibleMessages(feed, 25, 2, 30).map((m) => m.name),
  ["b", "c"],
);

// A wrapped message costs its full height: two two-line messages fill a four-line panel, and
// nothing older gets in behind them.
const long = "x".repeat(50);
const wrapped: ChatMessage[] = [msg(1, "old", "hi"), msg(2, "p", long), msg(3, "q", long)];
const shown = visibleMessages(wrapped, 10, 4, 30);
assert.deepEqual(
  shown.map((m) => m.name),
  ["p", "q"],
);
assert.equal(
  shown.reduce((n, m) => n + m.lines.length, 0),
  4,
);

// Wrapping: no line exceeds the budget, the first line is short by `name: `, and every word
// survives the trip.
const words = "the quick brown fox jumps over the lazy dog and then keeps on running";
const [one] = visibleMessages([msg(1, "runner", words)], 5, 20, 24);
assert.ok(one!.lines.length > 1, "a 68-character message must not stay on one line at 24 chars");
assert.ok(one!.lines[0]!.length <= 24 - ("runner".length + 2), "first line must leave room for the name");
assert.ok(
  one!.lines.every((l) => l.length <= 24),
  "no wrapped line may exceed the character budget",
);
assert.equal(one!.lines.join(" ").split(/\s+/).join(" "), words);

// A single word longer than the panel is cut rather than allowed to overflow.
const [link] = visibleMessages([msg(1, "u", "y".repeat(70))], 5, 20, 24);
assert.ok(
  link!.lines.every((l) => l.length <= 24),
  "an unbreakable word must be cut to the line budget",
);

// A message taller than the whole panel is truncated rather than leaving the panel blank.
const [huge] = visibleMessages([msg(1, "u", "z".repeat(500))], 5, 3, 20);
assert.equal(huge!.lines.length, 3);

// Colour: readable ones pass through untouched, Twitch's dark presets are lifted off the panel,
// and a user with no colour gets the muted grey rather than nothing.
assert.equal(readableColor("#FF69B4"), "#ff69b4");
assert.equal(readableColor(null), "#8d8695");
for (const dark of ["#000000", "#0000FF", "#008000", "#696969", "#2E8B57"]) {
  const lifted = readableColor(dark);
  assert.notEqual(lifted.toLowerCase(), dark.toLowerCase(), `${dark} is unreadable on the panel as-is`);
  assert.match(lifted, /^#[0-9a-f]{6}$/);
}
// Black has no hue to preserve, so it can only become grey — but a *readable* grey.
assert.notEqual(readableColor("#000000"), "#000000");
assert.equal(readableColor("#zzz"), "#8d8695");

// Geometry: the 480x346 timer-strip footprint the panel is designed for holds a sensible feed.
assert.equal(chatCharsPerLine(480), 36);
assert.equal(chatMaxLines(346), 13);
assert.ok(chatCharsPerLine(120) >= 8, "a narrow panel still reports a usable budget");
assert.ok(chatMaxLines(40) >= 1, "a short panel still reports at least one line");

console.log("chat panel layout ok");
