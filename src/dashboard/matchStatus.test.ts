// Self-check for matchStatus.ts: the disk-only POV nickname reader (the same one matchStatusFor
// itself uses) and the blocklist gate built on it for a match that has no working directory yet.
// Run: npx tsx src/dashboard/matchStatus.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { blockedOnDisk, matchIsBlocked, povNicknamesOnDisk } from "./matchStatus.js";

const dir = mkdtempSync(path.join(tmpdir(), "matchstatus-"));

// --- povNicknamesOnDisk: the POV clips, never the pipeline's own generated MP4s ------------------
assert.deepEqual(povNicknamesOnDisk(path.join(dir, "missing")), [], "a directory that does not exist yet");

const matchPath = path.join(dir, "1");
mkdirSync(matchPath, { recursive: true });
// Both kinds in one directory, as a rendered match's always are: the generated ones must never
// be read as a third and fourth player.
for (const f of [
  "edcr.mp4",
  "Aquacorde.mp4",
  "overlay-timer.mp4",
  "final-1.mp4",
  "series-1.mp4",
  "short-1.mp4",
  "smoke-1.mp4",
  "overlay-top.png",
  "chat-edcr.json",
]) {
  writeFileSync(path.join(matchPath, f), "x");
}
assert.deepEqual(
  povNicknamesOnDisk(matchPath),
  ["Aquacorde", "edcr"],
  "the two POV clips, sorted — every generated MP4 and non-MP4 file left out",
);
console.log("OK: povNicknamesOnDisk reads the POV clips, never the pipeline's own generated MP4s");

// --- blockedOnDisk: clips archived, the chats and the title still name the players (11 Oct 2026) --
{
  const only = (name: string, files: Record<string, string>) => {
    const d = path.join(dir, name);
    mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(d, f), text);
    return d;
  };
  assert.equal(
    blockedOnDisk(only("chat", { "chat-BeefSalad.json": "[]", "chat-silverrruns.json": "[]" })),
    true,
  );
  assert.equal(
    blockedOnDisk(
      only("title", {
        "match-2.title.txt": "Rematch: doogile leads 4-1 | doogile vs Aquacorde | MCSR Ranked 1v1",
      }),
    ),
    true,
  );
  assert.equal(
    blockedOnDisk(
      only("clean", {
        "chat-edcr.json": "[]",
        "match-3.title.txt": "A HOOK | edcr vs doogile | MCSR Ranked 1v1",
      }),
    ),
    false,
  );
  assert.equal(blockedOnDisk(matchPath), true, "the POV clips still count (Aquacorde.mp4 above)");
  console.log("OK: blockedOnDisk reads the clips, the saved chats and the title");
}

// --- matchIsBlocked: the gate for a brand-new render, before its working directory exists --------
config.mediaDir = dir;
const players: Record<number, [string, string]> = {
  10: ["Aquacorde", "doogile"],
  11: ["edcr", "doogile"],
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  const pair = m && players[Number(m[1])];
  if (pair) {
    return new Response(
      JSON.stringify({
        status: "success",
        data: { players: [{ nickname: pair[0] }, { nickname: pair[1] }] },
      }),
    );
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const saved = config.blockedPlayers;
config.blockedPlayers = ["aquacorde"]; // any case
assert.equal(await matchIsBlocked(10), true, "a blocked player, read straight from the API");
assert.equal(await matchIsBlocked(11), false, "neither player is blocked");
config.blockedPlayers = [];
assert.equal(await matchIsBlocked(10), false, "and an empty list blocks nobody");
config.blockedPlayers = saved;

// A down API degrades to "?" nicknames (matchStatusFor's own fallback), which block nobody —
// never a reason to refuse a render the operator could otherwise have started by hand.
globalThis.fetch = (async () => {
  throw new Error("API down");
}) as typeof fetch;
config.blockedPlayers = ["aquacorde"];
assert.equal(await matchIsBlocked(999), false, "a match the API cannot read is not blocked, not refused");
// Unless its directory, clips archived, still names the player: the Render button on a shelved match.
mkdirSync(path.join(dir, "998"));
writeFileSync(path.join(dir, "998", "chat-Aquacorde.json"), "[]");
assert.equal(await matchIsBlocked(998), true, "an archived directory's chats still block, API or not");
config.blockedPlayers = saved;

console.log("OK: matchIsBlocked reads the live API and the directory, and a down API alone blocks nobody");
console.log("matchStatus: all checks passed");
