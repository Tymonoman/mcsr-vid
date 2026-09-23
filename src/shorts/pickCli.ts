/**
 * npm run pick -- <matchId | all> [--force]
 *
 * The Short's moment picker in the open (src/shorts/videoPick.ts): it makes the proxy, runs /watch
 * on each POV clip (src/shorts/watchPov.ts, `watchScript`), asks the configured `reasonerCommand`
 * and prints, per match, each stage's time, the prompt's size, the model's raw answer (and the
 * retry when it answered nothing), why it was rejected when it was, and the pick it wrote. A pick
 * newer than its video is kept unless --force. `all` walks every match directory with a finished
 * video — a series counts once, under game 1, since the join deletes the other games' exports.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseMatchId } from "../api/mcsrApi.js";
import { config, matchDir } from "../config.js";
import { pickShortMoment } from "./videoPick.js";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: npm run pick -- <matchId | all> [--force]");
  process.exit(2);
}
const hasVideo = (id: number) =>
  ["final", "series"].some((kind) => existsSync(path.join(matchDir(id), `${kind}-${id}.mp4`)));
const ids =
  target === "all"
    ? readdirSync(config.mediaDir)
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .filter(hasVideo)
        .sort((a, b) => a - b)
    : [parseMatchId(target)];

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
for (const id of ids) {
  console.error(`--- ${id}`);
  const pick = await pickShortMoment(id, {
    force: args.includes("--force"),
    signal: controller.signal,
    log: (line) => console.error(`  ${line}`),
  });
  console.log(JSON.stringify(pick, null, 2));
}
