/**
 * npm run reason -- <matchId>
 *
 * The Short's reasoner exchange in the open: the heuristic's candidates, the exact prompt the
 * configured command receives, and its answer as applied. For trying `agy` by hand on the lab
 * before trusting it with a nightly cut; nothing is rendered or written.
 */
import { matchDir } from "./config.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { askReasoner, reasonerConfigured, reasonerPrompt } from "./reasoner.js";
import { distinctShortMoments } from "./shortMoment.js";
import { applyShortReason, SHORT_REASON_TASK, shortReasonInput } from "./shortReason.js";
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

const opts = {
  leftUuid: left.uuid,
  rightUuid: right.uuid,
  runMs: match.result.time || 900_000,
  chatAtSec: readChatTimes(matchDir(matchId)),
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
const answer = await askReasoner(SHORT_REASON_TASK, input);
console.log("Answer:", JSON.stringify(answer));
const applied = applyShortReason(moments, answer, opts.runMs);
console.log(
  applied.reasoner.applied
    ? `Applied: cut ${mmss(applied.moments[0]!.startMs)}-${mmss(applied.moments[0]!.endMs)} — ${applied.reasoner.why ?? "(no reason given)"}`
    : "Not applied: the heuristic order stands.",
);
