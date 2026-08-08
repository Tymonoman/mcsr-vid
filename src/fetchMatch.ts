import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run fetch-match -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const matchId = parseMatchId(input);
const match = await getMatch(matchId);

const [playerA, playerB] = match.players;
if (!playerA || !playerB) {
  throw new Error(`Match ${matchId} does not have two players (found ${match.players.length}).`);
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
