/**
 * npm run reason -- <matchId>
 *
 * The Short's reasoner exchange in the open: the heuristic's candidates, the exact prompt the
 * configured command receives, and its answer as applied. For trying `agy` by hand on the lab
 * before trusting it with a nightly cut. It always asks afresh and saves the answer to
 * `short-reason.json`, so it is also the way to make the panel and the CLI take a new one.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { matchDir } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { reasonerConfigured, reasonerPrompt } from "./reasoner.js";
import { distinctShortMoments, runMsOf } from "./shortMoment.js";
import { REASON_FILE, reasonShortMoments, SHORT_REASON_TASK, shortReasonInput } from "./shortReason.js";
import { readChatTimes } from "./twitchChat.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run reason -- <matchId>");
  process.exit(2);
}
const matchId = parseMatchId(arg);
const match = await getMatch(matchId);
const [left, right] = match.players;
if (!left || !right) throw new Error(`Match ${matchId} does not have two players.`);

const dir = matchDir(matchId);
const opts = {
  leftUuid: left.uuid,
  rightUuid: right.uuid,
  runMs: runMsOf(match),
  chatAtSec: readChatTimes(dir),
};
const moments = distinctShortMoments(match, opts, 5);
const mmss = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
console.log(`Candidates for ${matchId} (heuristic order):`);
moments.forEach((m, i) => console.log(`  [${i}] ${mmss(m.startMs)}-${mmss(m.endMs)}  ${m.reason}`));

const input = shortReasonInput(match, moments, opts);
console.log("\n--- prompt ---\n" + reasonerPrompt(SHORT_REASON_TASK, input) + "--- end prompt ---\n");

if (!reasonerConfigured()) {
  console.log("reasonerCommand is not set; the prompt above is what it would receive.");
  process.exit(0);
}
if (!existsSync(dir)) {
  console.log(`${dir} does not exist (no VODs): nothing to cut, so nothing is asked or saved.`);
  process.exit(0);
}
const file = path.join(dir, REASON_FILE);
await rm(file, { force: true });
const applied = await reasonShortMoments(match, moments, opts, dir);
console.log("Answer:", JSON.parse(await readFile(file, "utf8")).answer, `(saved to ${file})`);
console.log(
  applied.reasoner.applied
    ? `Applied: cut ${mmss(applied.moments[0]!.startMs)}-${mmss(applied.moments[0]!.endMs)} — ${applied.reasoner.why ?? "(no reason given)"}`
    : "Not applied: the heuristic order stands.",
);
