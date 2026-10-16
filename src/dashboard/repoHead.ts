/**
 * Which commit is running, versus which one is checked out.
 *
 * `src/` is read at boot and the repo is a bind mount, so after a pull the server keeps running
 * the old code until it restarts (`POST /api/restart-when-idle`). The two hashes side by side say
 * so, and `needsRestart` says whether the commits between them touched anything the process holds.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The short hash HEAD points at, read from .git without spawning git; null when unreadable. */
export function repoHead(root: string = REPO_ROOT): string | null {
  try {
    // In a worktree `.git` is a file naming the real git dir, whose `commondir` names where
    // the refs live; in the main checkout both are `.git` itself.
    const dotGit = path.join(root, ".git");
    const gitDir = statSync(dotGit).isDirectory()
      ? dotGit
      : path.resolve(
          root,
          readFileSync(dotGit, "utf8")
            .trim()
            .replace(/^gitdir: /, ""),
        );
    const commonFile = path.join(gitDir, "commondir");
    const commonDir = existsSync(commonFile)
      ? path.resolve(gitDir, readFileSync(commonFile, "utf8").trim())
      : gitDir;
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    if (ref === null) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : null;
    const loose = path.join(commonDir, ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 7);
    // A ref git has packed (gc, or a fresh clone) lives in packed-refs as "<hash> <ref>".
    const packed = readFileSync(path.join(commonDir, "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Read once at boot: what this process is running. */
const BOOT_HEAD = repoHead();

/**
 * What a running process holds from boot: `src/` is imported once, `remotion/` is imported by it
 * and bundled once per process, the rest decides what runs. `public/` is served from disk per
 * request and docs (TASKS.md, handbook/, CLAUDE.md) are read by nobody, so those commits — most
 * of a day's — need no restart.
 */
const RESTART_PATHS = ["src", "remotion", "package.json", "package-lock.json", "tsconfig.json"];

let diffCache: { key: string; changed: boolean } | null = null;

/** Whether `boot`..`now` touched `RESTART_PATHS`, cached per pair so a poll spawns git once per
 *  new HEAD. Anything git cannot answer (an unknown hash, no git, a timeout) counts as changed: a needless
 *  prompt beats a silent miss. */
export function needsRestart(boot: string | null, now: string | null, root: string = REPO_ROOT): boolean {
  if (!boot || !now || boot === now) return false;
  const key = `${root}\0${boot}\0${now}`;
  if (diffCache?.key !== key) {
    let changed = false;
    try {
      execFileSync("git", ["diff", "--quiet", boot, now, "--", ...RESTART_PATHS], {
        cwd: root,
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      changed = true;
    }
    diffCache = { key, changed };
  }
  return diffCache.changed;
}

/** `{ boot, now, needsRestart }` — equal hashes while the running server is the checked-out code. */
export function codeVersions(): { boot: string | null; now: string | null; needsRestart: boolean } {
  const now = repoHead();
  return { boot: BOOT_HEAD, now, needsRestart: needsRestart(BOOT_HEAD, now) };
}
