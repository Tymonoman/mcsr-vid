/**
 * Argument parsing for `npm run clip` (src/clips/clipCli.ts), pulled out on its own so it can be
 * tested without spawning yt-dlp, ffmpeg or Remotion — this file has no side effects.
 */

export interface ClipArgs {
  /** A Twitch URL (a VOD or a clip) or a local file path. */
  source: string;
  /** Seconds into `source`, when both --from and --to are given (a VOD section; a clip is
   *  already trimmed and normally needs neither). */
  fromSec?: number;
  toSec?: number;
  title: string;
  speaker: string;
  when: string;
  credit: string;
  /** Directory name under <mediaDir>/clips/; defaults to a slugified title. */
  slug: string;
  /** Smoke-test cap in seconds on the composited output, like export:fast's --seconds. */
  seconds?: number;
}

/** "1:23:45" / "23:45" / "45" -> seconds. Throws on anything else, including a negative part. */
export function hhmmssToSeconds(input: string): number {
  const parts = input.split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`bad timestamp "${input}", expected HH:MM:SS, MM:SS or SS`);
  }
  return parts.reduce((sec, part) => sec * 60 + Number(part), 0);
}

/** A filesystem-safe directory name: lowercase, non-alphanumerics collapsed to one "-", trimmed. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "clip";
}

const flag = (argv: string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

export const CLIP_USAGE =
  '<twitch url or local file> [--from=HH:MM:SS --to=HH:MM:SS] --title="…" --speaker="…" ' +
  '--when="…" --credit="…" [--slug=…] [--seconds=N]';

/** Throws with a one-line, operator-readable message on anything missing or malformed. */
export function parseClipArgs(argv: string[]): ClipArgs {
  const source = argv.find((a) => !a.startsWith("--"));
  if (!source) throw new Error(`missing source. Usage: npm run clip -- ${CLIP_USAGE}`);

  const title = flag(argv, "title");
  const speaker = flag(argv, "speaker");
  const when = flag(argv, "when");
  const credit = flag(argv, "credit");
  const missing = (
    [
      ["--title", title],
      ["--speaker", speaker],
      ["--when", when],
      ["--credit", credit],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0)
    throw new Error(`missing ${missing.join(", ")}. Usage: npm run clip -- ${CLIP_USAGE}`);

  const fromStr = flag(argv, "from");
  const toStr = flag(argv, "to");
  if ((fromStr === undefined) !== (toStr === undefined)) {
    throw new Error("--from and --to must be given together");
  }
  const fromSec = fromStr !== undefined ? hhmmssToSeconds(fromStr) : undefined;
  const toSec = toStr !== undefined ? hhmmssToSeconds(toStr) : undefined;
  if (fromSec !== undefined && toSec !== undefined && toSec <= fromSec) {
    throw new Error(`--to (${toStr}) must be after --from (${fromStr})`);
  }

  const secondsStr = flag(argv, "seconds");
  const seconds = secondsStr !== undefined ? Number(secondsStr) : undefined;
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new Error(`--seconds must be a positive number, got "${secondsStr}"`);
  }

  const slug = flag(argv, "slug") ?? slugify(title!);

  return {
    source,
    fromSec,
    toSec,
    title: title!,
    speaker: speaker!,
    when: when!,
    credit: credit!,
    slug,
    seconds,
  };
}
