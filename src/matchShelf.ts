/**
 * Hiding and deleting match working directories from the dashboard.
 *
 * archive.ts states the standing policy — copy to the NAS, never move, never delete, "freeing
 * space stays a separate, manual decision". This is that manual decision, made explicit and
 * given a button, not a loosening of the policy. Two things keep it from being a footgun:
 *
 *   - a match with work in flight cannot be deleted, so a delete can never race a render that
 *     is still writing into the directory it is removing;
 *   - the reply says whether an archived copy exists, so the caller can tell a recoverable
 *     delete from a permanent one and warn accordingly.
 *
 * Hiding is the reversible option and the one the list uses by default: it only filters the
 * dashboard, and touches nothing on disk inside the match directory.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { channelUploadsSnapshot, channelVideoFor } from "./channelUploads.js";
import { config, matchDir } from "./config.js";
import { readManifest } from "./thumbnailVariants.js";
import { HOOK_PLACEHOLDER } from "./title.js";
import { readUpload } from "./youtubeStore.js";

/** Where the NAS is mounted inside the container. Same default as archive.ts. */
const ARCHIVE_ROOT = process.env.MCSR_ARCHIVE_DIR ?? "/archive";

/**
 * Dot-prefixed so `listProcessedMatchIds` — which takes every `^\d+$` *directory* — cannot
 * mistake it for a match, and kept in mediaDir so the state travels with the media it describes
 * rather than with the checkout.
 */
const statePath = () => path.join(config.mediaDir, ".dashboard.json");

interface ShelfState {
  hidden: number[];
}

function read(): ShelfState {
  const file = statePath();
  if (!existsSync(file)) return { hidden: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ShelfState>;
    return { hidden: (parsed.hidden ?? []).filter((n) => Number.isSafeInteger(n)) };
  } catch {
    // A corrupt preferences file must not take the dashboard down over a cosmetic setting.
    return { hidden: [] };
  }
}

export function hiddenMatchIds(): Set<number> {
  return new Set(read().hidden);
}

export function setHidden(matchId: number, hidden: boolean): void {
  const state = read();
  const next = state.hidden.filter((id) => id !== matchId);
  if (hidden) next.push(matchId);
  writeFileSync(statePath(), JSON.stringify({ hidden: next.sort((a, b) => a - b) }, null, 2));
}

export interface DeleteResult {
  matchId: number;
  bytesFreed: number;
  /** Whether `<ARCHIVE_ROOT>/<id>` exists, i.e. whether this delete was recoverable. */
  archived: boolean;
}

async function dirBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** True when an archived copy exists, so a delete can be reported as recoverable. */
export const isArchived = (matchId: number): boolean => existsSync(path.join(ARCHIVE_ROOT, String(matchId)));

/**
 * Removes a match's working directory, reporting what it freed.
 *
 * Callers must already have refused if work is in flight; this deliberately knows nothing about
 * the job registries, so it stays testable without standing one up.
 */
export async function deleteMatch(matchId: number): Promise<DeleteResult> {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) throw new Error(`No working directory for match ${matchId}`);

  const bytesFreed = await dirBytes(dir);
  const archived = isArchived(matchId);
  await rm(dir, { recursive: true, force: true });
  // A hidden flag for a directory that no longer exists is just litter.
  setHidden(matchId, false);
  return { matchId, bytesFreed, archived };
}

/* --- Publish checklist ----------------------------------------------------------------------
 *
 * Uploading is manual while the YouTube API compliance audit is pending (videos.insert would
 * lock every upload private), so "is this match actually out the door?" lives in the operator's
 * head. Ten facts answer it; the five that happen in Studio or in a DM are stored here, the rest
 * are read off disk, because a stored copy of a derivable fact is a second thing that can be wrong.
 */

/** The facts nothing in this repo can see, because they happen in Studio or in a DM. */
// endScreenSet: end screens and cards have no API and are the cheapest session-time lever on the
// platform — a viewer who finishes one match is offered the next one by the channel, not by
// the algorithm. The rivalry playlist link in the description only helps the ones who scroll.
export const MANUAL_PUBLISH_KEYS = [
  "uploaded",
  "shortUploaded",
  "relatedLinkSet",
  "endScreenSet",
  "playersNotified",
] as const;
export type ManualPublishKey = (typeof MANUAL_PUBLISH_KEYS)[number];

export const isManualPublishKey = (key: unknown): key is ManualPublishKey =>
  MANUAL_PUBLISH_KEYS.includes(key as ManualPublishKey);

export type PublishChecklist = Record<ManualPublishKey, boolean> & {
  rendered: boolean;
  hookPicked: boolean;
  thumbnailChosen: boolean;
  uploaded: boolean;
  shortRendered: boolean;
  /** Both players' Twitch chat saved beside the media (src/twitchChat.ts) — the chat panel's input. */
  chatSaved: boolean;
};

/** Inside the match directory, so the state travels with the media — as `.dashboard.json` does. */
const publishPath = (matchId: number): string => path.join(matchDir(matchId), "publish.json");

function readManual(matchId: number): Record<ManualPublishKey, boolean> {
  let stored: Partial<Record<ManualPublishKey, unknown>> = {};
  try {
    stored = JSON.parse(readFileSync(publishPath(matchId), "utf8")) as typeof stored;
  } catch {
    // Missing and corrupt both mean "nothing ticked yet", which is the recoverable answer: the
    // operator re-ticks the five manual boxes rather than the detail panel refusing to open.
  }
  return Object.fromEntries(MANUAL_PUBLISH_KEYS.map((k) => [k, stored[k] === true])) as Record<
    ManualPublishKey,
    boolean
  >;
}

/** Writes one manual flag. Callers must have validated the key — see `isManualPublishKey`. */
export function setPublishFlag(matchId: number, key: ManualPublishKey, value: boolean): void {
  writeFileSync(publishPath(matchId), JSON.stringify({ ...readManual(matchId), [key]: value }, null, 2));
}

/**
 * The merged checklist. `projectPath` is passed in rather than looked up so this stays a pure
 * disk read: the route already holds a `matchStatusFor` entry, and asking for one here would
 * cost an MCSR API request per pill.
 */
/** How many `chat-<nick>.json` files sit beside the media; two is a match. */
function chatFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => /^chat-.+\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * Uploaded by the dashboard (youtube.json beside the media), found on the channel by the match
 * link in its description (src/channelUploads.ts — how a Studio upload announces itself), or
 * ticked by hand. The tick is the fallback for a video the link cannot find.
 */
export async function isUploaded(matchId: number): Promise<boolean> {
  return (
    (await readUpload(matchId)) !== null ||
    readManual(matchId).uploaded ||
    channelVideoFor(matchId, channelUploadsSnapshot()) !== null
  );
}

/**
 * A finished MP4 under either name the two encoders write. A hand-named export is still found
 * by the preview (`findExportedVideo`); this is the cheap read the match list can afford per row.
 */
export function isExported(matchId: number): boolean {
  const dir = matchDir(matchId);
  return existsSync(path.join(dir, "final.mp4")) || existsSync(path.join(dir, `final-${matchId}.mp4`));
}

export async function publishChecklist(
  matchId: number,
  projectPath: string | null,
): Promise<PublishChecklist> {
  const dir = matchDir(matchId);
  const editedTitle = path.join(dir, `match-${matchId}.title.edited.txt`);
  // The same test the upload route runs before it will send anything (youtubeRoutes.ts): a title
  // still carrying the placeholder has no hook, whatever else was edited around it.
  const firstLine = existsSync(editedTitle) ? readFileSync(editedTitle, "utf8").split("\n")[0]!.trim() : "";

  return {
    ...readManual(matchId),
    rendered: projectPath !== null,
    hookPicked: firstLine !== "" && !firstLine.includes(HOOK_PLACEHOLDER),
    thumbnailChosen: Boolean((await readManifest(dir))?.chosen),
    uploaded: await isUploaded(matchId),
    shortRendered: existsSync(path.join(dir, `short-${matchId}.mp4`)),
    chatSaved: chatFiles(dir) >= 2,
  };
}
