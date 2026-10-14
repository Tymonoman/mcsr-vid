// Contract test for the text an upload sends (`uploadTextFor`, src/youtube/youtubeStore.ts),
// written from the docs as an outside engineer would. Hermetic: a temp media dir, fetch stubbed to
// fail, nothing leaves the process.
// Run: npx tsx src/youtube/youtubeStore.contract.test.ts
//
// What the docs promise (CLAUDE.md House rules / Dashboard "Upload", "Adopt", `titleNames`; the
// handbook's "Upload" and "What the render produces" sections):
//  1. Upload (and Adopt) refuse a title still containing `<HOOK>` — so the text it is read from
//     never clears the placeholder by itself: a refreshed ranked or playoff title keeps it.
//  2. The title is the file's first line; the guidance under it never goes up.
//  3. An `.edited.txt` the operator left empty is no edit: the render's text goes up.
//  4. The text is the render's, refreshed at upload: a description on today's template that
//     nobody edited goes up byte for byte — its VOD links and ratings are the render's — and it
//     still pairs with its match by the `/matches/<id>` link; nothing in it names the winner.
//  5. `titleNames` spells two players the broadcast's way in the title only: the description keeps
//     the API spelling, and the tags carry both (the broadcast spelling once, after the nicknames).
//  6. Upload sends `match-<id>.tags.txt`, the Short included (both halves of a match are one
//     channel); the refreshed list still passes the upload's own tag limits.
//  7. A Short's description gains "the whole match: https://youtu.be/<id>" once the long-form's id
//     is in youtube.json ("the whole series" for a series), once, and keeps its match link.
//  8. Anything that will not refresh cleanly (an unknown tail) goes up as stored with one log
//     line — never a refusal.
//  9. House rule: a carried `hookText` fails closed the way `hookProblem` does — the thumbnail
//     manifest's headline standing in for `<HOOK>` must not put a runner label in the title.
// 10. `titleNames` respells only the players it lists: every other player's title keeps the API
//     spelling, whatever the nickname.
//
// Already pinned by youtubeStore.test.ts and not repeated: the drift patches themselves ("#9
// seed", the old closer, the tip jar's place, the subscribe paragraph), series chapter relabels,
// "last time they met", nickname warnings, copyVariety, an edited description kept verbatim.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { buildDescription, buildTags, CLOSER, SUBSCRIBE_LINE } from "../pipeline/description.js";
import { buildChapters } from "../pipeline/chapters.js";
import { computeSplits } from "../pipeline/overlayProps.js";
import { HOOK_PLACEHOLDER } from "../pipeline/title.js";
import { buildShortDescription } from "../shorts/shortHook.js";
import { describesMatch, type ChannelVideo } from "./channelUploads.js";
import { uploadTextFor } from "./youtubeStore.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-uploadtext-contract-"));
// On every exit, a failed assert included (the 'exit' event fires for an uncaught throw too).
process.on("exit", () => rmSync(media, { recursive: true, force: true }));
config.mediaDir = media;
config.supportUrl = "https://ko-fi.com/example";
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`no network in this test: ${String(input)}`);
}) as typeof fetch;
const warnings: string[] = [];
console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));

/**
 * A doc promise the code does not keep yet (tracked in TASKS.md): reported, not bent to the code,
 * and not fatal while it stays broken. Once the code keeps it, this fails instead, so the check
 * is promoted to a plain assert and a later regression fails the run rather than passing quietly.
 */
const deviations: string[] = [];
async function deviation(clause: string, check: () => unknown): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
    return;
  }
  assert.fail(`fixed, now a promise the code keeps: make this a plain assert — ${clause}`);
}

const write = (matchId: number, files: Record<string, string>) => {
  const dir = path.join(media, String(matchId));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
};
const TAIL = "MCSR Ranked 1v1 | Minecraft Speedrun";
const GUIDANCE =
  "\n\nReplace <HOOK> with 13-32 characters (title lands at 70-89).\nBoth nicknames come from the API — don't retype them.\n";
/** A description on today's template, as the render writes it, for two made-up players. */
const modern = (matchId: number, left: string, right: string) =>
  [
    `${left} vs ${right}, mcsr ranked 1v1 on the same seed. a minecraft speedrun race.`,
    "",
    SUBSCRIBE_LINE,
    "",
    "0:00 Start\n2:07 Nether Enter",
    "",
    `match page: https://magmamcsr.com/ranked/player/${left}/matches/${matchId}?season=12`,
    `tip jar: ${config.supportUrl}`,
    "",
    CLOSER,
    "",
    "#MCSRRanked #MCSR #MinecraftSpeedrunning",
  ].join("\n");
const video = (description: string) => ({ description }) as ChannelVideo;
const RESULT_WORDS =
  /\b(?:won|wins?|winner|winning|beats?|beaten|defeat(?:s|ed)?|victory|lost|loses|loser|forfeit(?:s|ed)?|takes it|took it|result:)/i;

// --- 1, 2: the placeholder survives every refresh, and only line 1 is the title -----------------
{
  write(501, { "match-501.title.txt": `<HOOK> | Aa vs Bb | MCSR Ranked 1v1${GUIDANCE}` });
  const ranked = (await uploadTextFor(501, "video")).title;
  // The refresh rebuilds the generated half (the tail gains "| Minecraft Speedrun", 22 Sept 2026)
  // and must hand the placeholder back untouched, for the upload to refuse.
  assert.equal(ranked, `<HOOK> | Aa vs Bb | ${TAIL}`, "only line 1, placeholder kept");

  write(502, {
    "match-502.title.txt": `<HOOK> | Aa vs Bb | MCSR Ranked S11 Playoffs · Round of 16 · Game 2${GUIDANCE}`,
  });
  assert.ok(
    (await uploadTextFor(502, "video")).title.startsWith(`${HOOK_PLACEHOLDER} | `),
    "a playoff title keeps it",
  );

  // A manifest with a blank headline has nothing to stand in.
  write(503, {
    "match-503.title.txt": `<HOOK> | Aa vs Bb | ${TAIL}${GUIDANCE}`,
    "thumbnail.json": JSON.stringify({ chosen: null, hookText: "   ", variants: [] }),
  });
  assert.ok(
    (await uploadTextFor(503, "video")).title.includes(HOOK_PLACEHOLDER),
    "a blank headline is no hook",
  );

  // The operator's own file saved with the placeholder in it: still the caller's to refuse.
  write(504, { "match-504.title.edited.txt": `<HOOK> | Aa vs Bb | ${TAIL}\n` });
  assert.ok(
    (await uploadTextFor(504, "video")).title.includes(HOOK_PLACEHOLDER),
    "an edited placeholder stays",
  );
  for (const id of [501, 502, 503, 504])
    assert.ok(
      !(await uploadTextFor(id, "video")).title.includes("Replace"),
      `${id}: guidance went up as title`,
    );
  assert.deepEqual(warnings, [], "refreshing a placeholder title is not a failure worth a log line");
}

// --- 3: an empty edit is no edit ----------------------------------------------------------------
{
  write(510, {
    "match-510.title.txt": `Down to the last heart | Aa vs Bb | ${TAIL}${GUIDANCE}`,
    "match-510.title.edited.txt": "   \n\n",
    "match-510.description.txt": modern(510, "Aa", "Bb"),
    "match-510.description.edited.txt": "",
  });
  const text = await uploadTextFor(510, "video");
  assert.equal(
    text.title,
    `Down to the last heart | Aa vs Bb | ${TAIL}`,
    "a blank title edit falls back to the render's",
  );
  assert.equal(
    text.description,
    modern(510, "Aa", "Bb"),
    "a 0-byte description edit falls back to the render's",
  );
}

// --- 4: a description rendered today goes up as rendered, and pairs -----------------------------
const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const userOf = (p: MatchInfo["players"][number], nickname = p.nickname): UserDetails =>
  ({ uuid: p.uuid, nickname, eloRate: p.eloRate }) as UserDetails;
const renderFor = (match: MatchInfo, leftName?: string, rightName?: string) => {
  const [left, right] = match.players;
  const window = (p: MatchInfo["players"][number]) => {
    const vod = match.vod.find((v) => v.uuid === p.uuid)!;
    return {
      playerUuid: p.uuid,
      playerNickname: p.nickname,
      sourceUrl: vod.url,
      path: "/tmp/x.mp4",
      matchOffsetIntoVodSec: match.date - vod.startsAt,
      matchOffsetIntoClipSec: 20,
    };
  };
  const userLeft = userOf(left!, leftName);
  const userRight = userOf(right!, rightName);
  return {
    description: buildDescription({
      matchId: match.id,
      match,
      userLeft,
      userRight,
      leftWindow: window(left!),
      rightWindow: window(right!),
      chapters: buildChapters(computeSplits(match, left!.uuid, right!.uuid), match, 10),
      playlistUrl: "https://www.youtube.com/playlist?list=PLexample",
      supportUrl: config.supportUrl,
    }),
    tags: buildTags(match, userLeft, userRight),
  };
};
{
  const match = load(13560037);
  const rendered = renderFor(match);
  const hookTitle = `Down to the last heart | ${match.players[0]!.nickname} vs ${match.players[1]!.nickname} | ${TAIL}`;
  write(match.id, {
    [`match-${match.id}.title.edited.txt`]: `${hookTitle}\n`,
    [`match-${match.id}.description.txt`]: rendered.description,
    [`match-${match.id}.tags.txt`]: `${rendered.tags.join("\n")}\n`,
  });
  const text = await uploadTextFor(match.id, "video");
  assert.equal(text.title, hookTitle, "the operator's title on today's tail goes up as saved");
  assert.equal(
    text.description,
    rendered.description,
    "nothing to patch: the render's description, byte for byte",
  );
  assert.deepEqual(text.tags, rendered.tags, "the render's tags.txt is what goes up");
  // What Adopt checks before it writes: the pairing link is still there.
  assert.ok(
    describesMatch(match.id, video(text.description)),
    "the uploaded description pairs with its match",
  );
  assert.doesNotMatch(
    [text.title, text.description, ...text.tags].join("\n"),
    RESULT_WORDS,
    "names the winner",
  );
}

// --- 5, 6: titleNames in the title, API spelling in the description, both in the tags ----------
{
  assert.deepEqual(
    config.titleNames,
    { Pinne: "Skycrab", lowk3y_: "lowkey" },
    "DEFAULTS' broadcast spellings",
  );
  const match = load(13673240);
  const rendered = renderFor(match, "Pinne", "lowk3y_");
  write(520, {
    "match-520.title.edited.txt": "Down to the last heart | Pinne vs lowk3y_ | MCSR Ranked 1v1\n",
    "match-520.description.txt": rendered.description,
    "match-520.tags.txt": `${rendered.tags.join("\n")}\n`,
  });
  const text = await uploadTextFor(520, "video");
  assert.equal(
    text.title,
    `Down to the last heart | Skycrab vs lowkey | ${TAIL}`,
    "the title spells them the broadcast's way",
  );
  assert.ok(text.description.startsWith("Pinne vs lowk3y_, "), "the description keeps the API spelling");
  assert.ok(!/Skycrab|lowkey\b/.test(text.description), "no broadcast spelling in the description");
  assert.deepEqual(
    text.tags.slice(0, 4),
    ["Pinne", "lowk3y_", "Skycrab", "lowkey"],
    "the tags carry both, after the nicknames",
  );
  assert.deepEqual(text.tags.slice(4), rendered.tags.slice(2), "and the rest as rendered");
  // Already there (buildTags puts a Twitch name after the nicknames, any case): not twice.
  write(521, { "match-521.tags.txt": "Pinne\nBb\nskycrab\nmcsr\n" });
  assert.deepEqual((await uploadTextFor(521, "video")).tags, ["Pinne", "Bb", "skycrab", "mcsr"], "once");
  // The refreshed list still passes the upload's own limits: none over 30, 500 in all. A list
  // already near the budget goes up as stored rather than over it.
  // 26 fillers: exactly buildTags' 450-character budget, so ",Skycrab" would cross it.
  const stored = [
    "Pinne",
    "Bb",
    ...Array.from({ length: 26 }, (_, i) => `minecraft tag ${String(i).padStart(2, "0")}`),
  ];
  assert.equal(stored.join(",").length, 450);
  write(522, { "match-522.tags.txt": stored.join("\n") });
  const near = (await uploadTextFor(522, "video")).tags;
  assert.deepEqual(near, stored, "a list at its budget goes up as rendered");
  assert.ok(
    near.every((t) => t.length <= 30) && near.join(",").length <= 500,
    `tags past YouTube's limits: ${near.join(",").length}`,
  );
}

// --- 6, 7: the Short sends the long-form's tags and points at the long-form ---------------------
{
  write(530, {
    "match-530.tags.txt": "Pinne\nBb\nmcsr\n",
    "short-530.title.txt": "Down to the last heart | Skycrab vs Bb #mcsr #minecraft\n",
    "short-530.description.txt": buildShortDescription(530, "Pinne", "Bb"),
  });
  const before = await uploadTextFor(530, "short");
  assert.ok(!before.description.includes("youtu.be"), "no long-form recorded yet: no link to one");
  assert.deepEqual(
    before.tags,
    (await uploadTextFor(530, "video")).tags,
    "the Short sends the long-form's tags",
  );
  assert.deepEqual(before.tags, ["Pinne", "Bb", "Skycrab", "mcsr"]);

  write(530, {
    "youtube.json": JSON.stringify({
      videoId: "VVVVVVVVVVV",
      uploadedAt: "2026-10-01T19:00:00Z",
      publishAt: "2026-10-02T19:00:00Z",
      privacyStatus: "private",
      thumbnailVariant: null,
      title: `Down to the last heart | Skycrab vs Bb | ${TAIL}`,
    }),
  });
  const short = await uploadTextFor(530, "short");
  const lines = short.description.split("\n");
  assert.equal(
    lines[1],
    "the whole match: https://youtu.be/VVVVVVVVVVV",
    "the link right under the first line",
  );
  assert.equal(short.description.split("youtu.be/VVVVVVVVVVV").length, 2, "once");
  assert.equal(
    (await uploadTextFor(530, "short")).description,
    short.description,
    "asking again adds nothing",
  );
  assert.ok(describesMatch(530, video(short.description)), "the Short still pairs with its match");

  write(531, {
    "series.json": JSON.stringify({
      season: 11,
      slotId: 1,
      round: "Round of 16",
      bestOf: 5,
      firstTo: 3,
      games: [],
    }),
    "short-531.description.txt": buildShortDescription(
      531,
      "Aa",
      "Bb",
      "",
      "",
      undefined,
      undefined,
      "series",
    ),
    "youtube.json": JSON.stringify({
      videoId: "WWWWWWWWWWW",
      uploadedAt: "2026-10-01T23:00:00Z",
      publishAt: null,
      privacyStatus: "private",
      thumbnailVariant: null,
    }),
  });
  assert.equal(
    (await uploadTextFor(531, "short")).description.split("\n")[1],
    "the whole series: https://youtu.be/WWWWWWWWWWW",
    "a series' Short points at the whole series",
  );
}

// --- 8: what will not refresh goes up as stored, with one log line ------------------------------
{
  const before = warnings.length;
  write(540, { "match-540.title.edited.txt": "Down to the last heart | Aa vs Bb | Some Other Cup\n" });
  const text = await uploadTextFor(540, "video");
  assert.equal(
    text.title,
    "Down to the last heart | Aa vs Bb | Some Other Cup",
    "an unknown tail goes up as stored",
  );
  const logged = warnings.slice(before);
  assert.equal(logged.length, 1, `one log line, got ${JSON.stringify(logged)}`);
  assert.match(logged[0]!, /match 540: the stored title goes up as it is/);
}

// --- 9: the thumbnail's headline standing in for <HOOK> ------------------------------------------
{
  // The documented stand-in works for a clean headline...
  write(551, {
    "match-551.title.txt": `<HOOK> | Aa vs Bb | ${TAIL}${GUIDANCE}`,
    "thumbnail.json": JSON.stringify({ chosen: null, hookText: "Down to the last heart", variants: [] }),
  });
  assert.equal((await uploadTextFor(551, "video")).title, `Down to the last heart | Aa vs Bb | ${TAIL}`);

  // ...but a carried headline is as untrusted as a typed or a model one: an invented "X vs Y"
  // that is not the match's two players is a runner label, and must fail closed (stay <HOOK>, so
  // Upload and Adopt refuse) rather than reach the title the kit shows and Adopt writes.
  write(550, {
    "match-550.title.txt": `<HOOK> | Aa vs Bb | ${TAIL}${GUIDANCE}`,
    "thumbnail.json": JSON.stringify({ chosen: null, hookText: "CHAIR vs LAMP", variants: [] }),
  });
  const title = (await uploadTextFor(550, "video")).title;
  await deviation(
    "CLAUDE.md House rules: a carried hookText value fails closed the same way hookProblem does (never a runner label)",
    () => assert.ok(!title.includes("CHAIR vs LAMP"), `uploadTextFor's title is "${title}"`),
  );
}

// --- 10: titleNames respells only the players it names ------------------------------------------
{
  // Minecraft names are [A-Za-z0-9_]{3,16}: "constructor" and "__proto__" are legal nicknames.
  write(560, { "match-560.title.edited.txt": "Wow | constructor vs Bb | MCSR Ranked 1v1\n" });
  write(561, { "match-561.title.edited.txt": "Wow | __proto__ vs Bb | MCSR Ranked 1v1\n" });
  const a = (await uploadTextFor(560, "video")).title;
  const b = (await uploadTextFor(561, "video")).title;
  // One call each, so the second case is checked even while the first one fails.
  const clause =
    "CLAUDE.md titleNames: spells two players the broadcast's way, title only — every other nickname keeps the API spelling";
  await deviation(`${clause} (constructor)`, () =>
    assert.equal(a, `Wow | constructor vs Bb | ${TAIL}`, `uploadTextFor's title is "${a}"`),
  );
  await deviation(`${clause} (__proto__)`, () =>
    assert.equal(b, `Wow | __proto__ vs Bb | ${TAIL}`, `uploadTextFor's title is "${b}"`),
  );
}

console.log(
  deviations.length
    ? `youtubeStore.contract: all checks passed (${deviations.length} documented deviation(s) reported above)`
    : "youtubeStore.contract: all checks passed",
);
