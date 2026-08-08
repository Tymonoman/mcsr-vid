import { spawn } from "node:child_process";
import path from "node:path";
import { getMatch, getUser, parseMatchId } from "./mcsrApi.js";
import { computeThumbnailProps } from "./thumbnailProps.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run generate-thumbnail -- <mcsrranked.com match URL or match ID>");
  process.exit(1);
}

const matchId = parseMatchId(input);
const match = await getMatch(matchId);

const [playerLeft, playerRight] = match.players;
if (!playerLeft || !playerRight) {
  throw new Error(`Match ${matchId} does not have two players.`);
}

const [userLeft, userRight] = await Promise.all([
  getUser(playerLeft.uuid),
  getUser(playerRight.uuid),
]);

const props = await computeThumbnailProps(match, userLeft, userRight);

const outDir = path.join("media", String(matchId));
const outPath = path.join(outDir, "thumbnail.png");

console.error(`Rendering thumbnail for match ${matchId}...`);

await new Promise<void>((resolve, reject) => {
  const proc = spawn(
    "npx",
    ["remotion", "still", "remotion/index.ts", "Thumbnail", outPath, `--props=${JSON.stringify(props)}`],
    { stdio: "inherit" },
  );
  proc.on("error", reject);
  proc.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`remotion still exited with code ${code}`));
  });
});

console.error(`Done: ${outPath}`);
console.log(JSON.stringify({ matchId, path: outPath }, null, 2));
