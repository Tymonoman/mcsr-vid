/**
 * npm run short:hand -- <matchId> <path/to/file.mp4> --hook "<title hook>" --from <sec> --to <sec> --pov left|right [--note "<text>"]
 *
 * Turns a Short cut outside the pipeline into the pair the publish chain reads
 * (`config.shortsByHand`, src/shorts/handShort.ts): copies the file to `short-<id>.mp4`, writes
 * its title/description the same way `npm run short` does, and `short-<id>.hand.json`. Refuses —
 * writing nothing — before the hook, the blocked-player check or the match record: bad hook,
 * wrong file shape, already on the channel, a blocked player (`checkHandShort`).
 *
 * Both `--flag=value` and `--flag value` are accepted: the rest of this codebase's CLIs use the
 * former (`npm run short -- <id> --at=<ms>`), but a hook passed as a bare `--hook <value>` is the
 * more natural shape for a line typed by hand.
 */
import { parseMatchId } from "../api/mcsrApi.js";
import { requireArg } from "../cliArgs.js";
import { buildHandShort, HandShortRefusal } from "./handShort.js";

const USAGE =
  '<matchId> <path/to/file.mp4> --hook "<title hook>" --from <sec> --to <sec> --pov left|right [--note "<text>"]';

const matchId = parseMatchId(requireArg("short:hand", USAGE));
const rest = process.argv.slice(3);
const mp4Path = rest[0];

function flag(name: string): string | undefined {
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
}

const hook = flag("hook");
const from = flag("from");
const to = flag("to");
const pov = flag("pov");
const note = flag("note");

if (
  !mp4Path ||
  mp4Path.startsWith("--") ||
  !hook ||
  from === undefined ||
  to === undefined ||
  (pov !== "left" && pov !== "right")
) {
  console.error(`Usage: npm run short:hand -- ${USAGE}`);
  process.exit(1);
}

try {
  const result = await buildHandShort(matchId, {
    mp4Path,
    hook,
    fromSec: Number(from),
    toSec: Number(to),
    pov,
    ...(note ? { note } : {}),
  });
  console.error(`Done: ${result.outPath}\nTitle: ${result.title}`);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  if (err instanceof HandShortRefusal) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
