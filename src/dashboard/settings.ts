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
 * **`youtubeUploadEnabled`, `nightlyUpload` and `studioAutomation` are deliberately not here.**
 * One switches the live channel's upload path, the second what a nightly does with its MP4, the
 * third whether a real Chrome ever signs into the channel owner's own Google account — a
 * mis-click on any of them shows up on the channel. They stay a deliberate edit on the box.
 * All three are reported read-only so the panel can still say where they stand.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { config, CONFIG_PATH, CTA_REASON_MAX_CHARS, validateOverrides, type Config } from "../config.js";

/** `Config` has no index signature; this is the one place that reaches it by key. */
const live = config as unknown as Record<string, unknown>;

export type SettingKind = "boolean" | "int" | "hour" | "text" | "words" | "list";

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
    key: "ctaReason",
    label: "Subscribe card's reason",
    help: `One row above SUBSCRIBE on the mid-race line and on the card after the finish, saying why: ${CTA_REASON_MAX_CHARS} characters at most, because the card after the finish sits under the final time and has room for one row. Empty shows the bare SUBSCRIBE and FOR THE NEXT ONE card. Applies to the next render.`,
    kind: "text",
    group: "Publishing",
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
    key: "introSec",
    label: "Intro card (seconds)",
    help: "How long the versus card covers the start of the countdown, 2 to 7. The finished MP4 keeps the last 3 s of the countdown after the card and cuts the seconds before it, so match start comes at the card's length + 3 s (7 → 0:10, 3 → 0:06). The 24 Sept audit measured the first 3% of every video losing a median 22.5 points and proposed 3. Applies to the next render.",
    kind: "int",
    group: "Publishing",
    min: 2,
    max: 7,
  },
  {
    key: "countdownTeaser",
    label: "Large coming-up teaser",
    help: "The COMING UP line (a moment later in the race, naming nobody) large across the bottom of both POVs from the intro card's end to match start, clear of the countdown digit. Only when the match has such a moment. Applies to the next render and export.",
    kind: "boolean",
    group: "Publishing",
  },
  {
    key: "exportUpscale1440",
    label: "Upload at 2560x1440 (upscaled)",
    help: "export:fast's final pass blows the finished 1080p frame up to 2560x1440 before encoding — no extra detail, every overlay asset stays 1080p — to test whether YouTube's transcoder grants a higher bitrate tier for a 1440p upload. A 20 s CPU test (7 Oct 2026) measured 12% bigger files and 44% longer encodes; the lab's GPU path is untested. A playoff series needs every game exported with the same setting, or the games cannot be joined. Applies to the next export.",
    kind: "boolean",
    group: "Publishing",
    unattended: true,
  },
  {
    key: "explainMovesSec",
    label: "Explain the moves (seconds on screen)",
    help: "The first time either player reaches a split, the meta column says what it is for, in words for someone who has never watched a speedrun: BASTION, TRADING GOLD TO PIGLINS FOR ENDER PEARLS. Never who got there. The subscribe line and the teaser go first; a card waits for them. Empty shows none. Applies to the next render.",
    kind: "int",
    group: "Publishing",
    min: 1,
    max: 15,
    nullable: true,
  },
  {
    key: "autoHooksAfterHours",
    label: "Auto-save hooks after (hours)",
    help: "The operator's own grant, 8 Oct 2026: a match whose hooks are still unsaved this many hours after its pick lands gets the best title hook that passes the usual checks (the model's, else a hooks.ts chip) and a Short hook chosen the same way, and the chain runs as if Save had been pressed. Empty is off. The morning report's \"Auto-saved hooks\" block lists every one, so a bad pick can be changed before its upload.",
    kind: "int",
    group: "Publishing",
    min: 1,
    max: 48,
    nullable: true,
    unattended: true,
  },
  {
    key: "seriesPublishHourUtc",
    label: "Series publish hour (UTC)",
    help: "The slot a playoff series video takes, its own so it and the day's ranked match do not compete. 23:00 UTC is 19:00 on the US east coast.",
    kind: "hour",
    group: "Publishing",
  },
  {
    key: "seriesPairGapDays",
    label: "Days between a pair's ranked video and series",
    help: "The publish slot keeps a ranked video and a series of the same two players this many days apart; 0 is off. The doogile–Aquacorde series drew 84 views beside their ranked video's 2,095 the same day.",
    kind: "int",
    group: "Publishing",
    min: 0,
    max: 30,
  },
  {
    key: "thumbnailRotatePoses",
    label: "Rotate the auto thumbnail pose",
    help: "Off: a fresh render's auto-picked thumbnail is always the first pose pair (today's look on every match). On: it picks deterministically by match id among the pose pairs actually rendered, so the auto default is not the same pose on 88% of uploads. An operator's pick and an already-uploaded thumbnail are never touched either way.",
    kind: "boolean",
    group: "Publishing",
    unattended: true,
  },
  {
    key: "copyVariety",
    label: "Vary the pinned comment and description wording",
    help: "Rotates the pinned comment's sync line and the description's closer and subscribe lines through a few phrasings of the same facts, one per match id, so a re-render or re-upload keeps the same wording. Off is today's single byte-identical wording on every video.",
    kind: "boolean",
    group: "Publishing",
    unattended: true,
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
    key: "commentSoonAfterPublish",
    label: "Comment soon after publish",
    help: "Post the first comment within 5-20 minutes of a scheduled video going public, instead of waiting for the nightly's tick hours later. Same comment, same once-only checks — just timed to look less like a nightly batch job.",
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
    key: "blockedPlayers",
    label: "Blocked players",
    help: "MCSR nicknames separated by commas, case ignored. A match with one of these players is dropped before it is scored, never offered to the nightly (even if queued), never listed as worth rendering, never rendered or uploaded. Permanent — for a player who has withdrawn permission to use their footage.",
    kind: "list",
    group: "Suggestions",
    unattended: true,
  },
  {
    key: "favouritePlayers",
    label: "Favourite players",
    help: "MCSR nicknames separated by commas (Pinne is Skycrab, lowk3y_ is lowkey); case is ignored, spelling is not. The list sorts across the close and chaos cards, and a match with one of these players always comes before one with none, however popular that one is; among matches with a favourite, one counts half again as popular, two twice. The order changes at once and is what the nightly's first pick follows; which matches reach the list changes at the next scan (every 30 minutes or the rescan link), which gives its slots to such matches first. A match about to expire still comes first and one the rival already posted still comes last. Empty means no tier and no bonus: popularity across both buckets.",
    kind: "list",
    group: "Suggestions",
    unattended: true,
  },
  {
    key: "pairRepeatDays",
    label: "Days before a pair repeats",
    help: "A match whose two players this channel already put out a video for (public, scheduled, or rendered and still waiting for its hooks) within this many days either side of now counts for half in the list and in the nightly's first pick, so another pair goes first — among matches of the same kind: a repeated favourite pair still comes before a no-name one. Never skipped: a rematch still renders when nothing else qualifies. 0 is off. Applies on the next read.",
    kind: "int",
    group: "Suggestions",
    min: 0,
    max: 30,
    unattended: true,
  },
  {
    key: "knownFollowerThreshold",
    label: "Known-opponent follower threshold",
    help: "A player off the favourites list with no measured draw ranks a match above the no-name ones (still below every favourite's) once their Twitch following reaches this many, and the nightly renders no unqueued match without such a player. Default 10,000: below it the sampled players drew at or below the channel's median.",
    kind: "int",
    group: "Suggestions",
    min: 0,
    max: 1_000_000,
    unattended: true,
  },
  {
    key: "learnedDraw",
    label: "Learn draw from the channel's own views",
    help: "A player with 3+ measured long-form videos gets a learned draw (each video's first-7-day views ÷ the channel median), replacing the hand-seeded DEFAULT_DRAW/UNMEASURED_DRAW for them; a pair whose last measured meeting beat the median skips the repeat halving. Needs a YouTube token and recomputes on the 15-minute tick, at most once a day. Off is byte-for-byte today's ordering.",
    kind: "boolean",
    group: "Suggestions",
    unattended: true,
  },
  {
    key: "recordPaceBoostSec",
    label: "Record-pace boost threshold (seconds)",
    help: "A candidate finishing at or under this many seconds gets its audience boosted, ranking a near-record race up inside its tier — never names or implies who won, only reorders. Empty is off.",
    kind: "int",
    group: "Suggestions",
    min: 0,
    max: 3600,
    nullable: true,
    unattended: true,
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
    key: "suggestKnownSlots",
    label: "Known-player slots",
    help: "Cards for a known player's match on top of the above, close or chaotic or not.",
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
  "studioAutomation",
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
  // Empty is the empty list, not null: "none" is a value the loader accepts, and it replaces a default.
  if (field.kind === "list") return { value: text.split(/\s*,\s*/).filter(Boolean) };
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
