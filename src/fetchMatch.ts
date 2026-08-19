import { requireArg } from "./cliArgs.js";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";

const matchId = parseMatchId(requireArg("fetch-match"));
const match = await getMatch(matchId);

const [playerA, playerB] = match.players;
if (!playerA || !playerB) {
  throw new Error(`Match ${matchId} does not have two players (found ${match.players.length}).`);
}
if (match.vod.length < 2) {
  console.error(
    `WARNING: match ${matchId} has only ${match.vod.length}/2 VOD(s) attached. ` +
      `generate-project requires both and will fail — this match isn't uploadable as-is.`,
  );
}

const [userA, userB, versus] = await Promise.all([
  getUser(playerA.uuid),
  getUser(playerB.uuid),
  getVersus(playerA.uuid, playerB.uuid),
]);

console.log(
  JSON.stringify(
    {
      match,
      players: { [playerA.nickname]: userA, [playerB.nickname]: userB },
      versus,
    },
    null,
    2,
  ),
);
