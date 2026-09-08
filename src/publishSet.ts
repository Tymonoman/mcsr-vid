/**
 * Getting a finished match onto the PC that publishes it.
 *
 * A *pull* from the PC, not a push from the lab: the dashboard image has rsync but no ssh
 * client (both containers share one image), and the PC already reaches the lab over ssh — it is
 * how the YouTube token gets there. So the dashboard's job is to hand over the exact command,
 * and nothing here ever runs: these are strings for the operator's own shell.
 *
 * The set is the publish set — the MP4, the Short, the thumbnails and the text. Never the VODs
 * (`<nick>.mp4`), the overlays, the chats or the .kdenlive project: those are gigabytes and
 * Studio has no use for them.
 */

/** The publish set for one match, as rsync/glob patterns. Also the .tar bundle's contents. */
export function publishSetPatterns(matchId: number): string[] {
  return [
    // Two names because two encoders write it: scripts/export.sh -> final.mp4,
    // `npm run export:fast` -> final-<id>.mp4 (see matchShelf.isExported).
    `final-${matchId}.mp4`,
    "final.mp4",
    `short-${matchId}.mp4`,
    "thumbnail.png",
    "thumbnail.*.png",
    `match-${matchId}.title.txt`,
    `match-${matchId}.title.edited.txt`,
    `match-${matchId}.description.txt`,
    `match-${matchId}.description.edited.txt`,
    `match-${matchId}.tags.txt`,
    `short-${matchId}.title.txt`,
    `short-${matchId}.description.txt`,
  ];
}

/** Whether one filename in a match directory belongs to the publish set. */
export function inPublishSet(matchId: number, name: string): boolean {
  return publishSetPatterns(matchId).some((pattern) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(name),
  );
}

/**
 * The same include list for every match, because the set is generic by pattern. Coarser than
 * `publishSetPatterns` by one file — `*.txt` also carries match-<id>.chapters.txt — which costs
 * a kilobyte and keeps the per-match and the everything command provably identical.
 */
const RSYNC_INCLUDES = ["final*.mp4", "short-*.mp4", "thumbnail*.png", "*.txt"];

const FILTERS = [...RSYNC_INCLUDES.map((p) => `--include='${p}'`), "--exclude='*'"].join(" ");

/**
 * Single-quote a path for the shell, but leave a leading `~/` outside the quotes: the dest is
 * the operator's home and `'~/Replayoffs/'` would create a directory literally named `~`.
 */
function shellPath(raw: string): string {
  const tilde = raw.startsWith("~/");
  const rest = (tilde ? raw.slice(2) : raw).replace(/'/g, `'\\''`);
  return `${tilde ? "~/" : ""}'${rest}'`;
}

/** Trailing slash on both ends, so rsync copies the *contents* into the dest rather than nesting. */
const dirArg = (base: string, leaf = ""): string => `${base.replace(/\/+$/, "")}/${leaf}`;

/**
 * rsync creates the last component of the dest and no more, so `~/Replayoffs/13172029/` fails
 * on the first ever pull with "No such file or directory" (measured). `--mkpath` would do it in
 * one flag, but it landed in rsync 3.2.3 and macOS still ships 2.6.9; `mkdir -p` works anywhere
 * and is silent unless it genuinely cannot, which is worth seeing.
 */
const into = (dest: string) => `mkdir -p ${shellPath(dest)} && rsync`;

/** One match's publish set. Run on the PC; `source` is an ssh target, `dest` a local directory. */
export function rsyncPullCommand(source: string, dest: string, matchId: number): string {
  const target = dirArg(dest, `${matchId}/`);
  return [
    `${into(target)} -av --progress`,
    FILTERS,
    shellPath(dirArg(source, `${matchId}/`)),
    shellPath(target),
  ].join(" ");
}

/**
 * Every match's publish set in one pass. `-m` prunes empty directories, so a match with nothing
 * finished does not turn up as an empty folder — but a match with *any* matching file (a
 * thumbnail alone, say) still does. Cheap to re-run: rsync sends only what changed.
 */
export function rsyncPullAllCommand(source: string, dest: string): string {
  const target = dirArg(dest);
  return [
    `${into(target)} -avm --progress`,
    "--include='*/'",
    FILTERS,
    shellPath(dirArg(source)),
    shellPath(target),
  ].join(" ");
}

/** The same thing on a schedule, so a nightly render is on the PC within ten minutes of finishing. */
export function cronLine(source: string, dest: string): string {
  return `*/10 * * * * ${rsyncPullAllCommand(source, dest)} >/dev/null 2>&1`;
}
