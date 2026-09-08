import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cronLine,
  inPublishSet,
  publishSetPatterns,
  rsyncPullAllCommand,
  rsyncPullCommand,
} from "./publishSet.js";

// The set is what Studio needs and nothing else: a VOD is ~4 GB and would make the pull useless.
const patterns = publishSetPatterns(13172029);
assert.ok(patterns.includes("final-13172029.mp4"), "the fast export's name");
assert.ok(patterns.includes("final.mp4"), "and the melt export's, which matchShelf also checks");
for (const name of [
  "final-13172029.mp4",
  "final.mp4",
  "short-13172029.mp4",
  "thumbnail.png",
  "thumbnail.walking-crossed.png",
  "match-13172029.title.txt",
  "match-13172029.title.edited.txt",
  "match-13172029.description.txt",
  "match-13172029.description.edited.txt",
  "match-13172029.tags.txt",
  "short-13172029.title.txt",
  "short-13172029.description.txt",
]) {
  assert.ok(inPublishSet(13172029, name), `${name} is part of the publish set`);
}
for (const name of [
  "Aquacorde.mp4",
  "NoHacsJustRoblox.mp4",
  "overlay-timer.mp4",
  "overlay-top.png",
  "overlay-intro.webm",
  "short-board.png",
  "chat-Infume.json",
  "match-13172029.kdenlive",
  "thumbnail.json",
  // Another match's files, in case the pull is ever pointed at a flattened directory.
  "final-12296170.mp4",
]) {
  assert.ok(!inPublishSet(13172029, name), `${name} must not be pulled`);
}
// The glob is anchored, not a substring match.
assert.ok(!inPublishSet(13172029, "not-final.mp4"));
assert.ok(!inPublishSet(13172029, "thumbnail.png.bak"));

// Exact strings: this is pasted into a shell, so quoting is the whole feature. `~` stays outside
// the quotes or bash makes a directory called "~"; everything else stays inside so a space in a
// path cannot split the argument.
assert.equal(
  rsyncPullCommand("homelab@actimel:/home/homelab/mcsr-media", "~/Replayoffs", 13172029),
  "mkdir -p ~/'Replayoffs/13172029/' && rsync -av --progress --include='final*.mp4' " +
    "--include='short-*.mp4' --include='thumbnail*.png' --include='*.txt' --exclude='*' " +
    "'homelab@actimel:/home/homelab/mcsr-media/13172029/' ~/'Replayoffs/13172029/'",
);
assert.equal(
  rsyncPullCommand("homelab@actimel:/home/homelab/mcsr-media/", "~/My Videos/Replayoffs", 1),
  "mkdir -p ~/'My Videos/Replayoffs/1/' && rsync -av --progress --include='final*.mp4' " +
    "--include='short-*.mp4' --include='thumbnail*.png' --include='*.txt' --exclude='*' " +
    "'homelab@actimel:/home/homelab/mcsr-media/1/' ~/'My Videos/Replayoffs/1/'",
  "a trailing slash in the config must not double, and a space must stay quoted",
);
assert.equal(
  rsyncPullAllCommand("homelab@actimel:/home/homelab/mcsr-media", "/mnt/d/Replayoffs"),
  "mkdir -p '/mnt/d/Replayoffs/' && rsync -avm --progress --include='*/' --include='final*.mp4' " +
    "--include='short-*.mp4' --include='thumbnail*.png' --include='*.txt' --exclude='*' " +
    "'homelab@actimel:/home/homelab/mcsr-media/' '/mnt/d/Replayoffs/'",
  "a dest with no ~ is quoted whole",
);
assert.equal(
  cronLine("homelab@actimel:/home/homelab/mcsr-media", "~/Replayoffs"),
  `*/10 * * * * ${rsyncPullAllCommand("homelab@actimel:/home/homelab/mcsr-media", "~/Replayoffs")} >/dev/null 2>&1`,
);

// A real run, because a filter list that reads right and transfers a 4 GB VOD is the failure
// mode this file exists to prevent. A local path source needs no ssh.
const tmp = mkdtempSync(path.join(tmpdir(), "publishset-"));
const source = path.join(tmp, "media");
const dest = path.join(tmp, "pc");
const wanted = [
  "final-1.mp4",
  "short-1.mp4",
  "thumbnail.png",
  "thumbnail.walking-crossed.png",
  "match-1.title.txt",
];
const unwanted = ["Aquacorde.mp4", "overlay-timer.mp4", "chat-x.json"];
mkdirSync(path.join(source, "1"), { recursive: true });
for (const name of [...wanted, ...unwanted]) writeFileSync(path.join(source, "1", name), name);

const bash = (script: string) => execFileSync("bash", ["-c", script], { encoding: "utf8" });
bash(rsyncPullCommand(source, dest, 1));
assert.deepEqual(
  readdirSync(path.join(dest, "1")).sort(),
  [...wanted].sort(),
  "one match: the publish set, whole",
);

// And the `~` claim itself, with HOME pointed at the temp tree: quoted whole, bash would make a
// directory literally called "~" next to the shell's cwd instead.
const home = path.join(tmp, "home");
mkdirSync(home, { recursive: true });
execFileSync("bash", ["-c", rsyncPullCommand(source, "~/Replayoffs", 1)], {
  env: { ...process.env, HOME: home },
});
assert.deepEqual(readdirSync(path.join(home, "Replayoffs", "1")).sort(), [...wanted].sort(), "~ expanded");
assert.ok(!readdirSync(tmp).includes("~"), "and no directory called ~ was created");

// The everything pass, with a second match that has only a thumbnail. `-m` prunes *empty*
// directories, so match 2 still appears — it has a matching file. A match with none would not.
mkdirSync(path.join(source, "2"), { recursive: true });
writeFileSync(path.join(source, "2", "thumbnail.png"), "2");
writeFileSync(path.join(source, "2", "Infume.mp4"), "vod");
mkdirSync(path.join(source, "3"), { recursive: true });
writeFileSync(path.join(source, "3", "Infume.mp4"), "vod");

const destAll = path.join(tmp, "pc-all");
bash(rsyncPullAllCommand(source, destAll));
assert.deepEqual(readdirSync(destAll).sort(), ["1", "2"], "a directory with nothing to pull is pruned");
assert.deepEqual(readdirSync(path.join(destAll, "1")).sort(), [...wanted].sort());
assert.deepEqual(readdirSync(path.join(destAll, "2")), ["thumbnail.png"]);

console.log("publishSet: all checks passed");
