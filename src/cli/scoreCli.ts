import { requireArg } from "../cliArgs.js";
import { config } from "../config.js";
import { chaosScore, closenessScore, computeMetrics, formatMetrics } from "../pipeline/matchScore.js";
import { getMatch, parseMatchId } from "../api/mcsrApi.js";

const matchId = parseMatchId(requireArg("score"));
const match = await getMatch(matchId);
const metrics = computeMetrics(match);

const { suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec } = config;
const close = closenessScore(metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec);
const chaos = chaosScore(metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec);

console.log(formatMetrics(metrics));
console.log("");
console.log(`Closeness     : ${close.toFixed(3)}`);
console.log(`Chaos         : ${chaos.toFixed(3)}`);
if (match.vod.length < 2) {
  console.log("");
  console.log(`NOTE: only ${match.vod.length}/2 VODs attached — this match can't be rendered as-is.`);
}
