/**
 * The settings the dashboard may change, and the one place that writes `mcsr-vid.config.json`.
 *
 * Two rules shape this file.
 *
 * **An allowlist, not the whole Config.** Most of `DEFAULTS` is infrastructure (`mediaDir`,
 * `youtubeChannelId`) or render internals whose values are load-bearing and documented elsewhere
 * (`preRollSec`, `overlayLeadInSec` — see the ANCHOR_SEC pitfall in CLAUDE.md). A web form is the
 * wrong place to discover that changing one silently slides every overlay late.
 *
 * **`youtubeUploadEnabled` and `nightlyUpload` are deliberately not here.** One switches the
 * live channel's upload path, the other what a nightly does with its MP4, and a mis-click on
 * either shows up on the channel. They stay a deliberate edit on the box.
 * Both are reported read-only so the panel can still say where they stand.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { config, CONFIG_PATH, validateOverrides, type Config } from "../config.js";

/** `Config` has no index signature; this is the one place that reaches it by key. */
const live = config as unknown as Record<string, unknown>;

export type SettingKind = "boolean" | "int" | "hour" | "text" | "words";

export interface SettingField {
  key: keyof Config;
  label: string;
  help: string;
  kind: SettingKind;
  group: string;
  /** `int`/`hour` bounds, inclusive. */
  min?: number;
  max?: number;
  /** Whether the empty box means `null` rather than 0 or "". */
  nullable?: boolean;
  /** Said out loud in the panel: these change what the machine does unattended. */
  unattended?: boolean;
}

/** Everything the panel may write. Order is the order it renders in. */
export const SETTINGS: readonly SettingField[] = [
  {
    key: "playoffsFirst",
    label: "Playoff games first",
    help: "The nightly takes detected playoff games ahead of the ordinary suggestions. On for the tournament, off after it, or ordinary matches sit behind an empty section.",
    kind: "boolean",
    group: "Nightly",
    unattended: true,
  },
  {
    key: "playoffThumbnailStyle",
    label: "Playoff thumbnails",
    help: "How a playoff game's thumbnails are framed: plain (the ranked look), bracket (the round in the band, the seed in the nameplate, the series length under the VS) or trophy (a gold PLAYOFFS wordmark and frame). Applies to the next render; re-render a series' game 1 to change one already on disk.",
    kind: "text",
    group: "Nightly",
  },
  {
    key: "nightlyRenderHourUtc",
    label: "Nightly hour (UTC)",
    help: "When the unattended render starts. Empty switches the nightly off entirely. Takes effect at once — the pending timer is re-armed.",
    kind: "hour",
    group: "Nightly",
    nullable: true,
    unattended: true,
  },
  {
    key: "nightlyMaxRenders",
    label: "Renders per night",
    help: "How many cards one night may work through. Each is a further ~21 minutes and ~2.2 GB.",
    kind: "int",
    group: "Nightly",
    min: 1,
    max: 4,
    unattended: true,
  },
  {
    key: "nightlyRenderExport",
    label: "Export the MP4 too",
    help: "Off leaves a project file and no video, which is a morning with nothing to publish.",
    kind: "boolean",
    group: "Nightly",
    unattended: true,
  },
  {
    key: "nightlyNotifyUrl",
    label: "Notify URL",
    help: "One line POSTed on done / failed / aborted. Empty is off.",
    kind: "text",
    group: "Nightly",
  },
  {
    key: "publishHourUtc",
    label: "Publish hour (UTC)",
    help: "The slot the publish kit proposes. 19:00 UTC is the competitor's measured hour.",
    kind: "hour",
    group: "Publishing",
  },
  {
    key: "midRollCtaAtSec",
    label: "Subscribe line during the race (seconds in)",
    help: "A subscribe line in the meta column this many seconds after match start, for four seconds; empty shows none. The post-roll card reaches 25–45% of viewers, the first split (~90 s) 50–60% (22 Sept 2026 audit). Applies to the next render.",
    kind: "int",
    group: "Publishing",
    min: 0,
    max: 3600,
    nullable: true,
  },
  {
    key: "teaserAtSec",
    label: "Coming-up teaser (seconds in)",
    help: "A COMING UP card in the meta column this many seconds after match start, for five seconds: the time and a line for a death, a lead change or a split under two seconds later in the race — never in its last minute, never naming anyone. Aimed at the 16–22 points every video loses in its first minute. Empty shows none. Applies to the next render.",
    kind: "int",
    group: "Publishing",
    min: 0,
    max: 50,
    nullable: true,
  },
  {
    key: "seriesPublishHourUtc",
    label: "Series publish hour (UTC)",
    help: "The slot a playoff series video takes, its own so it and the day's ranked match do not compete. 23:00 UTC is 19:00 on the US east coast.",
    kind: "hour",
    group: "Publishing",
  },
  {
    key: "youtubeAutoFinish",
    label: "Finish a Studio upload automatically",
    help: "When the channel scan pairs a new Studio upload, give it its thumbnail, playlists, first comment and tags without waiting to be asked. Not gated by the audit — none of those is videos.insert.",
    kind: "boolean",
    group: "Publishing",
    unattended: true,
  },
  {
    key: "youtubePlaylistUrl",
    label: "Season playlist URL",
    help: "The playlist every description links to, and the one the panel checks a video is in.",
    kind: "text",
    group: "Publishing",
  },
  {
    key: "pullSource",
    label: "Publish-set pull source",
    help: "rsync source the publish kit hands your PC, e.g. homelab@actimel:/home/homelab/mcsr-media. The lab host's path, not the container's.",
    kind: "text",
    group: "Publishing",
  },
  {
    key: "rivalChannelHandle",
    label: "Competitor handle",
    help: "Whose uploads are matched against the suggestions, so a match they already posted sorts last.",
    kind: "text",
    group: "Suggestions",
  },
  {
    key: "suggestCacheTtlMin",
    label: "Rescan every (min)",
    help: "How often the suggestion scan looks for new matches. Each full scan is ~340 MCSR API calls against a 500-per-10-minutes budget.",
    kind: "int",
    group: "Suggestions",
    min: 5,
    max: 720,
  },
  {
    key: "suggestCloseSlots",
    label: "Close slots",
    help: "How many decided-by-seconds cards the list holds.",
    kind: "int",
    group: "Suggestions",
    min: 0,
    max: 30,
  },
  {
    key: "suggestChaosSlots",
    label: "Chaos slots",
    help: "How many lead-changes-and-deaths cards sit under them.",
    kind: "int",
    group: "Suggestions",
    min: 0,
    max: 30,
  },
  {
    key: "postRollSec",
    label: "Post-roll (s)",
    help: "The most footage kept after the run ends. Cut earlier where the winner goes quiet, never under 15 s.",
    kind: "int",
    group: "Render",
    min: 15,
    max: 60,
  },
  {
    key: "postRollCta",
    label: "Subscribe card",
    help: "The last splits still, shown over the post-roll.",
    kind: "boolean",
    group: "Render",
  },
  {
    key: "renderConcurrency",
    label: "Render concurrency",
    help: "Remotion workers. Empty lets Remotion decide from the core count.",
    kind: "int",
    group: "Render",
    min: 1,
    max: 16,
    nullable: true,
  },
  {
    key: "reasonerCommand",
    label: "Reasoner command",
    help: "The CLI asked which 22 seconds to cut, e.g. `agy -p {prompt} --output-format json`. Split on spaces, so no quoted arguments. Empty switches it off and the heuristic decides alone.",
    kind: "words",
    group: "Reasoner",
  },
];

/** Reported beside the form, never written by it. */
export const READ_ONLY: readonly (keyof Config)[] = [
  "youtubeUploadEnabled",
  "nightlyUpload",
  "mediaDir",
  "youtubeChannelId",
];

const FIELDS = new Map(SETTINGS.map((f) => [f.key as string, f]));

/**
 * One field's submitted value, coerced to the type `Config` wants, or a message saying why not.
 *
 * The panel sends strings, because that is what an input holds. Coercing here rather than in the
 * route keeps the bounds next to the field that declares them.
 */
export function coerce(field: SettingField, raw: unknown): { value: unknown } | { error: string } {
  if (field.kind === "boolean") {
    if (typeof raw !== "boolean") return { error: `${field.label}: expected true or false` };
    return { value: raw };
  }
  const text = typeof raw === "string" ? raw.trim() : raw === null ? "" : String(raw);
  if (field.kind === "text") return { value: text };
  if (field.kind === "words") return { value: text === "" ? null : text.split(/\s+/) };
  if (text === "") {
    if (field.nullable) return { value: null };
    return { error: `${field.label}: cannot be empty` };
  }
  if (!/^-?\d+$/.test(text)) return { error: `${field.label}: expected a whole number` };
  const n = Number(text);
  const min = field.min ?? (field.kind === "hour" ? 0 : Number.NEGATIVE_INFINITY);
  const max = field.max ?? (field.kind === "hour" ? 23 : Number.POSITIVE_INFINITY);
  if (n < min || n > max) return { error: `${field.label}: must be between ${min} and ${max}` };
  return { value: n };
}

/** The file's own overrides, or `{}`. Read fresh: the panel must not drop a hand-edited key. */
function readOverrides(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export interface SaveResult {
  /** Keys whose value actually moved, for the log line and the panel's confirmation. */
  changed: string[];
  /** True when the nightly's arming has to be redone. */
  rearmNightly: boolean;
}

/**
 * Validates a patch, writes it into the overrides file and applies it to the live `config`.
 *
 * The write is atomic (temp file then rename) because the loader reads this at boot: a half-written
 * file is a dashboard that will not start. Validation is `validateOverrides` — the same function
 * the loader uses — over the *merged* object, so the panel cannot write a file that then fails to
 * load, and so a rule only stated there (a whole hour 0-23, or null) cannot drift from this file.
 */
export function saveSettings(patch: Record<string, unknown>): SaveResult {
  const merged = readOverrides();
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const field = FIELDS.get(key);
    if (!field) throw new Error(`"${key}" is not a setting this panel may change.`);
    const coerced = coerce(field, raw);
    if ("error" in coerced) throw new Error(coerced.error);
    const before = live[key];
    if (JSON.stringify(before) === JSON.stringify(coerced.value)) continue;
    merged[key] = coerced.value;
    changed.push(key);
  }
  if (changed.length === 0) return { changed, rearmNightly: false };

  validateOverrides(merged);
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  renameSync(tmp, CONFIG_PATH);

  // Only after the file is on disk: a live config that disagrees with the file is the one state
  // nothing else in the process can recover from.
  for (const key of changed) live[key] = merged[key];
  return { changed, rearmNightly: changed.includes("nightlyRenderHourUtc") };
}

/** What the panel renders: every field with its current value, plus the read-only facts. */
export function settingsPayload(): {
  fields: Array<SettingField & { value: unknown }>;
  readOnly: Array<{ key: string; value: unknown }>;
} {
  return {
    fields: SETTINGS.map((f) => ({ ...f, value: live[f.key as string] })),
    readOnly: READ_ONLY.map((key) => ({ key, value: live[key] })),
  };
}
