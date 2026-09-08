// Run: npx tsx src/repoHead.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeVersions, repoHead } from "./repoHead.js";

// The real repo: what git says, without spawning git in the server.
const git = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(repoHead(), git, "reads the checked-out commit");
assert.deepEqual(codeVersions(), { boot: git, now: git }, "a process is current right after boot");

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-head-"));
try {
  // A symbolic HEAD with a loose ref.
  await mkdir(path.join(dir, ".git", "refs", "heads"), { recursive: true });
  await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    path.join(dir, ".git", "refs", "heads", "main"),
    "0123456789abcdef0123456789abcdef01234567\n",
  );
  assert.equal(repoHead(dir), "0123456");
  // The same ref packed instead.
  await rm(path.join(dir, ".git", "refs", "heads", "main"));
  await writeFile(
    path.join(dir, ".git", "packed-refs"),
    "# pack-refs\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/main\n",
  );
  assert.equal(repoHead(dir), "fedcba9");
  // A detached HEAD.
  await writeFile(path.join(dir, ".git", "HEAD"), "89abcdef0123456789abcdef0123456789abcdef\n");
  assert.equal(repoHead(dir), "89abcde");
  // A worktree: `.git` is a file naming the worktree's git dir, and the refs live in the
  // common dir it points back at (the layout `git worktree add` makes).
  const common = path.join(dir, "common");
  await mkdir(path.join(common, "refs", "heads"), { recursive: true });
  await writeFile(path.join(common, "refs", "heads", "topic"), "abcdef0123456789abcdef0123456789abcdef01\n");
  const wt = path.join(dir, "wt");
  const wtGit = path.join(common, "worktrees", "wt");
  await mkdir(wtGit, { recursive: true });
  await mkdir(wt, { recursive: true });
  await writeFile(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
  await writeFile(path.join(wtGit, "HEAD"), "ref: refs/heads/topic\n");
  await writeFile(path.join(wtGit, "commondir"), "../..\n");
  assert.equal(repoHead(wt), "abcdef0", "a worktree resolves through its gitdir and commondir");
  // No repo at all: null, never a throw into a route.
  assert.equal(repoHead(path.join(dir, "nowhere")), null);
  console.log("repoHead: all checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
