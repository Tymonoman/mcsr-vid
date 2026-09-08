/**
 * Which commit is running, versus which one is checked out.
 *
 * `src/` is read at boot and the repo is a bind mount, so after a pull the server keeps running
 * the old code until `docker restart mcsr-dashboard`. The two hashes side by side say so.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The short hash HEAD points at, read from .git without spawning git; null when unreadable. */
export function repoHead(root: string = REPO_ROOT): string | null {
  try {
    const head = readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    if (ref === null) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : null;
    const loose = path.join(root, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 7);
    // A ref git has packed (gc, or a fresh clone) lives in packed-refs as "<hash> <ref>".
    const packed = readFileSync(path.join(root, ".git", "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Read once at boot: what this process is running. */
const BOOT_HEAD = repoHead();

/** `{ boot, now }` — equal while the running server is the checked-out code. */
export function codeVersions(): { boot: string | null; now: string | null } {
  return { boot: BOOT_HEAD, now: repoHead() };
}
