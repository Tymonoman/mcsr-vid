import assert from "node:assert/strict";
import { parseRange } from "./rangeStream.js";

const SIZE = 1000;

// No header, or one this parser deliberately does not honour, means "send the whole file".
assert.deepEqual(parseRange(undefined, SIZE), { kind: "none" });
assert.deepEqual(parseRange("bytes=-", SIZE), { kind: "none" });
assert.deepEqual(parseRange("items=0-99", SIZE), { kind: "none" });
// Multipart ranges: legal to answer with the whole file rather than a multipart/byteranges body.
assert.deepEqual(parseRange("bytes=0-99,200-299", SIZE), { kind: "none" });

// The ordinary case, and the one a media element actually sends when it opens a file.
assert.deepEqual(parseRange("bytes=0-", SIZE), { kind: "range", start: 0, end: 999 });
assert.deepEqual(parseRange("bytes=0-99", SIZE), { kind: "range", start: 0, end: 99 });
assert.deepEqual(parseRange("bytes=500-", SIZE), { kind: "range", start: 500, end: 999 });
assert.deepEqual(parseRange(" bytes=500-600 ", SIZE), { kind: "range", start: 500, end: 600 });

// `end` is inclusive, so the last byte is size-1. Off by one here serves a truncated file that
// plays fine until the final frame.
assert.deepEqual(parseRange("bytes=999-999", SIZE), { kind: "range", start: 999, end: 999 });
// An end past the file is clamped, not rejected — the spec says so and browsers rely on it.
assert.deepEqual(parseRange("bytes=900-99999", SIZE), { kind: "range", start: 900, end: 999 });

// Suffix form: the last N bytes. Chrome uses it to read the moov atom of a non-faststart file.
assert.deepEqual(parseRange("bytes=-100", SIZE), { kind: "range", start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-99999", SIZE), { kind: "range", start: 0, end: 999 });
assert.deepEqual(parseRange("bytes=-0", SIZE), { kind: "unsatisfiable" });

// Past the end, or inverted: 416, not a silent whole-file response that the player misreads.
assert.deepEqual(parseRange("bytes=1000-", SIZE), { kind: "unsatisfiable" });
assert.deepEqual(parseRange("bytes=1500-1600", SIZE), { kind: "unsatisfiable" });
assert.deepEqual(parseRange("bytes=600-500", SIZE), { kind: "unsatisfiable" });

// An empty file has no satisfiable range, and the suffix arithmetic would otherwise underflow.
assert.deepEqual(parseRange("bytes=0-", 0), { kind: "unsatisfiable" });
assert.deepEqual(parseRange("bytes=-10", 0), { kind: "unsatisfiable" });
assert.deepEqual(parseRange(undefined, 0), { kind: "none" });

// Every satisfiable range must be inside the file and non-empty, whatever the input.
for (const header of ["bytes=0-", "bytes=0-0", "bytes=-1", "bytes=999-", "bytes=1-99999"]) {
  const r = parseRange(header, SIZE);
  assert.equal(r.kind, "range", `${header} should be satisfiable`);
  if (r.kind !== "range") continue;
  assert.ok(r.start >= 0 && r.end < SIZE && r.start <= r.end, `${header} produced ${r.start}-${r.end}`);
}

console.log("rangeStream: all checks passed");
