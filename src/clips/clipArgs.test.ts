import assert from "node:assert/strict";
import { hhmmssToSeconds, slugify, parseClipArgs } from "./clipArgs.js";

// hhmmssToSeconds
assert.equal(hhmmssToSeconds("45"), 45);
assert.equal(hhmmssToSeconds("2:03"), 123);
assert.equal(hhmmssToSeconds("1:02:03"), 3723);
assert.equal(hhmmssToSeconds("00:00:00"), 0);
assert.throws(() => hhmmssToSeconds("1:2:3:4"), /bad timestamp/);
assert.throws(() => hhmmssToSeconds("abc"), /bad timestamp/);
assert.throws(() => hhmmssToSeconds("-1:00"), /bad timestamp/);
assert.throws(() => hhmmssToSeconds(""), /bad timestamp/);

// slugify
assert.equal(slugify("FEINBERG ON THE EDCR SITUATION"), "feinberg-on-the-edcr-situation");
assert.equal(slugify("  --Weird!!  Spacing--  "), "weird-spacing");
assert.equal(slugify("日本語"), "clip"); // nothing left after stripping — never an empty dir name

// parseClipArgs: the full happy path
{
  const args = parseClipArgs([
    "https://www.twitch.tv/feinberg/clip/JoyousAdorableSpiderHumbleLife-3GPZB80F539h_S9K",
    "--title=FEINBERG ON THE EDCR SITUATION",
    "--speaker=FEINBERG",
    "--when=on stream · 16 Sept 2026",
    "--credit=twitch.tv/feinberg",
  ]);
  assert.equal(
    args.source,
    "https://www.twitch.tv/feinberg/clip/JoyousAdorableSpiderHumbleLife-3GPZB80F539h_S9K",
  );
  assert.equal(args.slug, "feinberg-on-the-edcr-situation"); // derived from the title when --slug is absent
  assert.equal(args.fromSec, undefined);
  assert.equal(args.toSec, undefined);
  assert.equal(args.seconds, undefined);
}

// An explicit --slug wins over the derived one.
{
  const args = parseClipArgs([
    "clip.mp4",
    "--title=T",
    "--speaker=S",
    "--when=W",
    "--credit=C",
    "--slug=feinberg-edcr-test",
  ]);
  assert.equal(args.slug, "feinberg-edcr-test");
}

// --from/--to together, converted to seconds.
{
  const args = parseClipArgs([
    "vod.mp4",
    "--from=01:02:03",
    "--to=01:03:00",
    "--title=T",
    "--speaker=S",
    "--when=W",
    "--credit=C",
  ]);
  assert.equal(args.fromSec, 3723);
  assert.equal(args.toSec, 3780);
}

// --seconds, a smoke-test cap.
{
  const args = parseClipArgs(["v.mp4", "--title=T", "--speaker=S", "--when=W", "--credit=C", "--seconds=5"]);
  assert.equal(args.seconds, 5);
}

// Missing source.
assert.throws(() => parseClipArgs(["--title=T", "--speaker=S", "--when=W", "--credit=C"]), /missing source/);

// Missing required flags, named together.
assert.throws(() => parseClipArgs(["v.mp4", "--title=T"]), /missing --speaker, --when, --credit/);

// --from without --to (and the reverse).
assert.throws(
  () => parseClipArgs(["v.mp4", "--from=00:00:10", "--title=T", "--speaker=S", "--when=W", "--credit=C"]),
  /--from and --to must be given together/,
);
assert.throws(
  () => parseClipArgs(["v.mp4", "--to=00:00:10", "--title=T", "--speaker=S", "--when=W", "--credit=C"]),
  /--from and --to must be given together/,
);

// --to at or before --from.
assert.throws(
  () =>
    parseClipArgs([
      "v.mp4",
      "--from=00:01:00",
      "--to=00:00:59",
      "--title=T",
      "--speaker=S",
      "--when=W",
      "--credit=C",
    ]),
  /--to \(00:00:59\) must be after --from \(00:01:00\)/,
);

// --seconds must be a positive number.
assert.throws(
  () => parseClipArgs(["v.mp4", "--title=T", "--speaker=S", "--when=W", "--credit=C", "--seconds=0"]),
  /--seconds must be a positive number/,
);
assert.throws(
  () => parseClipArgs(["v.mp4", "--title=T", "--speaker=S", "--when=W", "--credit=C", "--seconds=nope"]),
  /--seconds must be a positive number/,
);

console.log("clipArgs ok");
