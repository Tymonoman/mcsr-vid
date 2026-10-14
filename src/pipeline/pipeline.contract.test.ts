// Contract test for the pipeline's stages (`runPipeline`, src/pipeline/pipeline.ts), written from
// the docs as an outside engineer would: README "The pipeline", CLAUDE.md "What the render
// produces" + "Known pitfalls", handbook/claude-md-reference.md (same sections).
//
// The promises, as the docs make them:
//  P1  The stages run in order fetch → download → sync → render → thumbnail → write, and
//      `generate-project` runs every one up to `write` (README). No MP4, no export record.
//  P2  Each stage reuses what is already in `<mediaDir>/<id>/` (README): both POV clips on disk
//      skip the download (no yt-dlp), a finished render skips Remotion, every thumbnail variant
//      on disk skips the thumbnail render.
//  P3  `overlay-splits.json` is written last and means "the render finished" (CLAUDE.md): no
//      manifest, a manifest naming a still not on disk, or only a killed run's `.part` file is
//      not a finished render.
//  P4  Timeline zero is the countdown's first second: match start lands at exactly ANCHOR_SEC
//      (10 s) on the timeline, and the overlay layers sit at timeline 0 untrimmed (CLAUDE.md).
//  P5  Every consumer places the clips from `sync.json`, which the pipeline writes when the sync
//      stage decides — refined or kept-coarse, `source` says which (handbook).
//  P6  A hand fix (`source: "manual"`, `confidence: 1`) is kept by a re-run: the sync stage keeps
//      those numbers instead of re-running the detector (handbook "When the detector is not sure").
//  P7  A clip the picture cannot read keeps the coarse estimate (`config.preRollSec`) at
//      confidence 0, and the sync stage finishes as a warning, not an error (handbook).
//  P8  `exportStale` refuses an export whose sync.json was *corrected* after it was exported —
//      and only then (CLAUDE.md "a sync.json correction after export ... until re-encoded").
//  P9  The finished MP4 is not the timeline: `exportMatchStartSec(dir, id)` reads
//      `final-<id>.json`, and is 10 without a record, which is what a fresh generate-project
//      leaves (CLAUDE.md, handbook).
//  P10 Kdenlive stays at 0:10 whatever the card length; `export:fast` alone cuts `headTrimSec`
//      (CLAUDE.md "overlay-intro.webm").
//  P11 The description's chapters are written at render time and take
//      `headTrimSec(config.introSec)` (handbook "Timeline zero").
//  P12 A match keeps the card it was rendered with: export:fast takes the card's length from the
//      file (handbook "overlay-intro.webm") — so chapters must agree with where that export
//      puts match start.
//  P13 Generated projects carry `<mlt root>` with every resource relative to it (CLAUDE.md).
//  P14 The write stage leaves `.kdenlive`, title, description, chapters and tags (one per line)
//      beside the clips (README mermaid "write"), at absolute paths in the result.
//  P15 A VOD found once is remembered in `vods.json` and read back first, so a clip on disk stays
//      renderable after the archive is gone — no re-listing (handbook "A Twitch archive").
//  P16 Both VODs are needed: a match with one, attached or found, fails the fetch stage with the
//      "1/2 VODs" error and writes nothing (handbook; pipeline.ts).
//  P17 The chat save is best effort: a Twitch failure never fails the pipeline (README "+ chat").
//  P18 Nothing names the winner — no result line in the description, title, tags or chapters
//      (CLAUDE.md house rules).
//
// Hermetic: a temp mediaDir, every fetch mocked (no network), a fake `yt-dlp` first on PATH that
// records any call, tiny ffmpeg-made clips (well under 2 s), no Remotion/Chromium.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/pipeline/pipeline.contract.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchInfo, UserDetails, VersusStats } from "../api/types.js";
import { runPipeline, STAGE_ORDER, type StageEvent } from "./pipeline.js";
import { ANCHOR_SEC, offsetIntoClipFromProject } from "./kdenliveProject.js";
import { exportStale, readSyncOffsets, staleExportMessage, writeSyncOffsets } from "./syncFile.js";
import { exportMatchStartSec, headTrimSec, writeExportRecord } from "./exportFast.js";
import { overlayPaths, readSplitStills, SPLITS_MANIFEST } from "./overlayRender.js";
import { variantFile } from "../thumbnails/thumbnailVariants.js";
import { buildChapters, formatChapters } from "./chapters.js";
import { computeSplits } from "./overlayProps.js";

/** Keeps the assertion as the docs word it; a mismatch is reported, not hidden, and not fatal. */
const deviations: string[] = [];
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Sandbox: media, PATH, fetch, env.

const root = mkdtempSync(path.join(tmpdir(), "mcsr-pipeline-contract-"));
const savedMediaDir = config.mediaDir;
config.mediaDir = path.join(root, "media");
mkdirSync(config.mediaDir);
assert.ok(config.mediaDir.startsWith(tmpdir()), "refusing to run outside tmpdir");
// An operator's HOOK_SUGGEST_CMD would spawn a model; the built-in chips are what this pins.
delete process.env.HOOK_SUGGEST_CMD;

// Any yt-dlp call (a download or an archive listing) lands in this log instead of the network.
const fakeBin = path.join(root, "bin");
const ytdlpLog = path.join(root, "yt-dlp.log");
mkdirSync(fakeBin);
writeFileSync(path.join(fakeBin, "yt-dlp"), `#!/bin/sh\necho "$@" >> "${ytdlpLog}"\nexit 1\n`);
chmodSync(path.join(fakeBin, "yt-dlp"), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const ytdlpCalls = (): string => (existsSync(ytdlpLog) ? readFileSync(ytdlpLog, "utf8") : "");

// The saved fixtures are trimmed to what the scorers read; `changes` (elo deltas) is one the API
// always sends, empty here — a playoff game carries none either.
const fixture = (id: number): MatchInfo => {
  const m = JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as Partial<MatchInfo>;
  return { ...m, changes: m.changes ?? [] } as MatchInfo;
};

const userOf = (p: MatchInfo["players"][number], twitch?: string): UserDetails =>
  ({
    ...p,
    roleType: 0,
    achievements: { display: [], total: [] },
    timestamp: { firstOnline: 0, lastOnline: 0, lastRanked: 0, nextDecay: null },
    statistics: { season: null, total: {} },
    connections: twitch ? { twitch: { id: "1", name: twitch } } : {},
    seasonResult: null,
    weeklyRaces: [],
  }) as unknown as UserDetails;

const served = new Map<number, MatchInfo>();
const users = new Map<string, UserDetails>();
const fetchLog: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  fetchLog.push(url);
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ status: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const u = new URL(url);
  if (u.hostname === "api.mcsrranked.com") {
    let m: RegExpExecArray | null;
    if ((m = /^\/matches\/(\d+)$/.exec(u.pathname))) {
      const match = served.get(Number(m[1]));
      return match ? ok(match) : new Response("{}", { status: 404, statusText: "Not Found" });
    }
    if ((m = /^\/users\/([^/]+)\/versus\/([^/]+)$/.exec(u.pathname))) {
      const versus: VersusStats = {
        players: [users.get(m[1]!)!, users.get(m[2]!)!],
        results: { ranked: { total: 0 }, casual: { total: 0 } },
        changes: {},
      };
      return ok(versus);
    }
    if ((m = /^\/users\/([^/]+)$/.exec(u.pathname))) {
      const user = users.get(decodeURIComponent(m[1]!));
      return user ? ok(user) : new Response("{}", { status: 404, statusText: "Not Found" });
    }
  }
  // Twitch GQL (the chat save) and anything else: the network is not there in this test.
  throw new TypeError(`fetch failed: no network in this test (${url})`);
}) as typeof fetch;

function serve(match: MatchInfo, twitchNames = false): void {
  served.set(match.id, match);
  for (const p of match.players) users.set(p.uuid, userOf(p, twitchNames ? p.nickname : undefined));
}

// Tiny real media, made once: ffprobe has to read every duration the write stage asks for.
const ffmpeg = (...args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { timeout: 2000, stdio: "ignore" });
const media = path.join(root, "template");
mkdirSync(media);
// 160 s, so the coarse estimate (preRollSec = 150) still leaves the clip a tail on the timeline.
const POV = path.join(media, "pov.mp4");
ffmpeg(
  ...["-f", "lavfi", "-i", "color=c=black:s=320x180:r=1", "-t", "160"],
  ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", POV],
);
const TIMER = path.join(media, "timer.mp4");
ffmpeg(
  ...["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", "30"],
  ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", TIMER],
);
const cardOf = (sec: number): string => {
  const file = path.join(media, `intro-${sec}.webm`);
  ffmpeg(
    ...["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", String(sec)],
    ...["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", file],
  );
  return file;
};
const CARD7 = cardOf(7);
const CARD3 = cardOf(3);

/**
 * A match directory as a finished render leaves it: both clips, the overlay stills + manifest,
 * the RTA strip, the intro card and every thumbnail variant. The PNGs are only ever checked for
 * existence by the stages under test, so their bytes are placeholders.
 */
function stageMatch(match: MatchInfo, card: string): string {
  const dir = path.join(config.mediaDir, String(match.id));
  mkdirSync(dir, { recursive: true });
  for (const p of match.players) copyFileSync(POV, path.join(dir, `${p.nickname}.mp4`));
  const overlay = overlayPaths(dir);
  writeFileSync(overlay.top, "png");
  const stills = [0, 1].map((n) => {
    const file = path.join(dir, `overlay-splits-${n}.png`);
    writeFileSync(file, "png");
    return { path: file, startSec: n * 15, durationSec: 15 };
  });
  copyFileSync(TIMER, overlay.timer);
  copyFileSync(card, overlay.intro);
  writeFileSync(overlay.manifest, JSON.stringify(stills, null, 2));
  writeFileSync(path.join(dir, "thumbnail.png"), "png");
  for (const v of config.thumbnailVariants) writeFileSync(path.join(dir, variantFile(v)), "png");
  return dir;
}

async function run(
  input: string,
): Promise<{ events: StageEvent[]; result?: Awaited<ReturnType<typeof runPipeline>>; error?: Error }> {
  const events: StageEvent[] = [];
  try {
    const result = await runPipeline(input, { onEvent: (e) => events.push(e) });
    return { events, result };
  } catch (error) {
    return { events, error: error as Error };
  }
}
const terminal = (events: StageEvent[]) =>
  events.filter((e) => e.status !== "active" && e.status !== "pending");
const settled = (events: StageEvent[], stage: StageEvent["stage"]) =>
  terminal(events).find((e) => e.stage === stage);

/** Project paths a resource can carry: `<property name="resource">` and the `resource=` attribute. */
const resourcesOf = (xml: string): string[] => [
  ...[...xml.matchAll(/<property name="resource">([^<]*)<\/property>/g)].map((m) => m[1]!),
  ...[...xml.matchAll(/\bresource="([^"]*)"/g)].map((m) => m[1]!),
];

/** Every guide's (frame, comment) out of the project's guides JSON. */
const guidesOf = (xml: string): Array<{ pos: number; comment: string }> => {
  const raw = /<property name="kdenlive:docproperties\.guides">([^<]*)<\/property>/.exec(xml)?.[1];
  if (!raw) return [];
  const json = raw
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return JSON.parse(json) as Array<{ pos: number; comment: string }>;
};

try {
  // =============================================================================================
  // A. A finished render on disk with a hand-fixed sync: every stage reuses, the hand fix stands.
  {
    const match = fixture(12929221);
    serve(match);
    const dir = stageMatch(match, CARD7);
    const manual = {
      left: 12.5,
      right: 13.25,
      confidence: 1,
      detail: "hand-matched countdowns",
      source: "manual" as const,
    };
    writeSyncOffsets(dir, manual);

    const { events, result, error } = await run(`https://mcsrranked.com/stats/x/${match.id}?tab=1`);
    assert.equal(error, undefined, `the run must finish: ${error?.message}`);
    assert.ok(result);

    // P1: every stage, once, in the documented order — and nothing settled as an error.
    assert.deepEqual(
      terminal(events).map((e) => e.stage),
      STAGE_ORDER,
      "fetch → download → sync → render → thumbnail → write, each settled once",
    );
    assert.deepEqual(STAGE_ORDER, ["fetch", "download", "sync", "render", "thumbnail", "write"]);
    assert.ok(
      terminal(events).every((e) => e.status === "done"),
      "a fully reusable match is all green",
    );
    // P1: generate-project stops at `write` — there is no MP4 and no export record afterwards.
    assert.ok(!existsSync(path.join(dir, `final-${match.id}.mp4`)), "generate-project never encodes");
    assert.ok(!existsSync(path.join(dir, `final-${match.id}.json`)), "only export:fast writes the record");
    // P9: so anything seeking in a finished video of this match falls back to the timeline's 10 s.
    assert.equal(exportMatchStartSec(dir, match.id), 10);

    // P2: reuse, stage by stage, and with no yt-dlp spent (download or listing).
    assert.match(
      settled(events, "download")!.message ?? "",
      /reused/,
      "both clips on disk skip the download",
    );
    assert.match(settled(events, "render")!.message ?? "", /reused/, "a finished render skips Remotion");
    assert.match(
      settled(events, "thumbnail")!.message ?? "",
      new RegExp(`reused ${config.thumbnailVariants.length} variants`),
      "every variant on disk skips the thumbnail render",
    );
    assert.equal(ytdlpCalls(), "", "a reused match never calls yt-dlp");
    // The only reachable host is the MCSR API (the match, both users, the head-to-head); the
    // chat save's Twitch call is the one best-effort miss.
    assert.ok(
      fetchLog.every((u) => u.startsWith("https://api.mcsrranked.com/") || /twitch\.tv/.test(u)),
      `unexpected host: ${fetchLog.join(", ")}`,
    );
    // P17: the chat fetch failed (no network) and the run still finished; no chat file pretends.
    assert.ok(
      fetchLog.some((u) => /twitch\.tv/.test(u)),
      "the chat save was attempted",
    );
    assert.ok(!readdirSync(dir).some((f) => f.startsWith("chat-")), "a failed chat save writes no file");

    // P6: the hand fix is kept, byte for byte, and the sync stage says so.
    assert.deepEqual(readSyncOffsets(dir), manual, "a re-run never overwrites a manual sync");
    assert.match(settled(events, "sync")!.message ?? "", /manual/);

    // P14: the write stage's artifacts, at absolute paths, beside the clips.
    for (const p of [
      result.projectPath,
      result.thumbnailPath,
      result.chaptersPath,
      result.descriptionPath,
      result.titlePath,
    ]) {
      assert.ok(path.isAbsolute(p), `${p} must be absolute`);
      assert.ok(existsSync(p), `${p} must exist`);
      assert.equal(path.dirname(p), path.resolve(dir), "every artifact lives in the match directory");
    }
    assert.equal(result.matchId, match.id, "a full match URL resolves to its id");
    const tags = readFileSync(path.join(dir, `match-${match.id}.tags.txt`), "utf8");
    assert.ok(tags.endsWith("\n"), "tags file ends on a newline");
    const tagLines = tags.trimEnd().split("\n");
    assert.ok(
      tagLines.length > 1 && tagLines.every((t) => t.trim().length > 0 && !t.includes(",")),
      "one tag per line",
    );

    // P4 + P5 + P6: the project places each POV by sync.json's numbers, so match start sits at
    // exactly ANCHOR_SEC (10 s) on the timeline — reading the offset back out of the XML gives
    // exactly what sync.json says.
    const xml = readFileSync(result.projectPath, "utf8");
    assert.equal(ANCHOR_SEC, 10);
    assert.equal(offsetIntoClipFromProject(xml, "chain_video_left"), manual.left);
    assert.equal(offsetIntoClipFromProject(xml, "chain_video_right"), manual.right);
    assert.equal(
      offsetIntoClipFromProject(xml, "chain_audio_left"),
      manual.left,
      "audio follows its picture",
    );
    assert.equal(offsetIntoClipFromProject(xml, "chain_audio_right"), manual.right);
    // The overlay layers have a lead-in equal to the anchor: at timeline 0, untrimmed.
    for (const id of ["chain_overlay_0", "chain_overlay_2", "chain_overlay_3"]) {
      assert.match(
        xml,
        new RegExp(`<entry in="00:00:00\\.000" out="[^"]+" producer="${id}"`),
        `${id} untrimmed`,
      );
      assert.equal(offsetIntoClipFromProject(xml, id), ANCHOR_SEC, `${id} starts at timeline 0`);
    }
    // The "Match start" guide sits on the anchor (60 fps project).
    const start = guidesOf(xml).find((g) => /Match start/.test(g.comment));
    assert.ok(start, "a Match start guide is written when sync ran");
    assert.equal(start.pos, ANCHOR_SEC * 60, "the guide is at 0:10 on the timeline");

    // P13: <mlt root> is the match directory and no resource carries an absolute path.
    assert.match(xml, new RegExp(`<mlt root="${path.resolve(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    const absolute = resourcesOf(xml).filter((r) => path.isAbsolute(r));
    assert.deepEqual(absolute, [], "every resource is relative to <mlt root>");
    assert.ok(
      resourcesOf(xml).some((r) => r === `${match.players[0]!.nickname}.mp4`),
      "a POV clip resolves under root",
    );

    // P11/P12: a 7 s card cuts nothing, so chapters count match start from 0:10.
    const splits = computeSplits(match, match.players[0]!.uuid, match.players[1]!.uuid);
    const chapters = readFileSync(result.chaptersPath, "utf8");
    assert.equal(chapters, formatChapters(buildChapters(splits, match, 10)));
    assert.match(chapters, /^0:00 Start\n/, "YouTube needs the first chapter at 0:00");

    // P18: no written text names the winner as such.
    const winner = match.players.find((p) => p.uuid === match.result.uuid)!.nickname;
    for (const file of [
      result.titlePath,
      result.descriptionPath,
      result.chaptersPath,
      path.join(dir, `match-${match.id}.tags.txt`),
    ]) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(
        text,
        /\b(winner|won|wins|victory|defeats?|beats)\b/i,
        `${path.basename(file)} must not carry a result line`,
      );
      assert.doesNotMatch(text, new RegExp(`${winner}\\s+(takes|took|won|wins|beats)`, "i"));
    }

    // =========================================================================================
    // E. The same match after its export. P8: only a *correction* of sync.json makes the export
    // stale. A re-run that keeps the hand fix changes nothing about where the clips sit.
    const final = path.join(dir, `final-${match.id}.mp4`);
    writeFileSync(final, "mp4");
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(path.join(dir, "sync.json"), hourAgo - 60, hourAgo - 60);
    utimesSync(final, hourAgo, hourAgo);
    assert.equal(exportStale(dir, final).stale, false, "sync decided before the export: not stale");

    const rerun = await run(String(match.id));
    assert.equal(rerun.error, undefined);
    assert.deepEqual(readSyncOffsets(dir), manual, "the hand fix survives a second re-run too");
    deviation(
      'CLAUDE.md Known pitfalls: exportStale refuses only after "a sync.json correction after export" — a re-run that keeps the manual sync is no correction',
      () =>
        assert.equal(
          exportStale(dir, final).stale,
          false,
          "re-running generate-project on an exported, hand-synced match marks its export stale (sync.json rewritten with identical numbers)",
        ),
    );

    // A real correction after the export is stale, and the refusal names the fix.
    writeSyncOffsets(dir, { ...manual, right: manual.right + 0.5 });
    utimesSync(path.join(dir, "sync.json"), hourAgo + 60, hourAgo + 60);
    const stale = exportStale(dir, final);
    assert.equal(stale.stale, true, "a sync correction after export must refuse the upload");
    assert.equal(stale.staleMatchId, match.id);
    assert.match(
      staleExportMessage(match.id, stale.staleMatchId),
      new RegExp(`npm run export:fast -- ${match.id}`),
    );

    // P9: once export:fast records where match start landed, that is what seeks read.
    writeExportRecord(dir, match.id, { matchStartSec: 6 });
    assert.equal(exportMatchStartSec(dir, match.id), 6);
    // The record is per match: another id's record in the same directory is not this one's.
    assert.equal(exportMatchStartSec(dir, match.id + 1), 10);
    // A record that is not a usable second is no record (never seek to -4 s or to "6").
    for (const bad of [-4, "6", null, Number.MAX_VALUE * 10]) {
      writeFileSync(path.join(dir, `final-${match.id}.json`), JSON.stringify({ matchStartSec: bad }));
      assert.equal(exportMatchStartSec(dir, match.id), 10, `matchStartSec ${String(bad)} falls back to 10`);
    }
    writeFileSync(path.join(dir, `final-${match.id}.json`), "{}");
    assert.equal(exportMatchStartSec(dir, match.id), 10, "a record without the field falls back to 10");
  }

  // =============================================================================================
  // B. No sync.json, a picture the detector cannot read, and a 3 s card kept from an older render.
  {
    const match = fixture(13446429);
    serve(match);
    const dir = stageMatch(match, CARD3);
    assert.equal(readSyncOffsets(dir), null);

    const { events, result, error } = await run(String(match.id));
    assert.equal(error, undefined, `the run must finish: ${error?.message}`);
    assert.ok(result);

    // P7: the sync stage settles as a warning and the run carries on.
    assert.equal(settled(events, "sync")!.status, "warn", "an unread countdown is a warning, not an error");
    assert.equal(settled(events, "write")!.status, "done");
    // P5 + P7: sync.json is written in the kept-coarse case too, saying so.
    const sync = readSyncOffsets(dir);
    assert.ok(sync, "sync.json is written even when the detector found nothing");
    assert.equal(sync.source, "coarse");
    assert.equal(sync.confidence, 0);
    assert.equal(sync.left, config.preRollSec, "the download estimate stands");
    assert.equal(sync.right, config.preRollSec);

    // P5 + P10: the project places by sync.json and still puts match start at 0:10 — a 3 s card
    // does not move the Kdenlive timeline.
    const xml = readFileSync(result.projectPath, "utf8");
    assert.equal(offsetIntoClipFromProject(xml, "chain_video_left"), sync.left);
    assert.equal(offsetIntoClipFromProject(xml, "chain_video_right"), sync.right);
    assert.equal(
      offsetIntoClipFromProject(xml, "chain_overlay_3"),
      ANCHOR_SEC,
      "the card lies over the countdown at 0",
    );
    const guide = guidesOf(xml).find((g) => /Match start/.test(g.comment));
    assert.equal(guide?.pos, ANCHOR_SEC * 60, "Kdenlive stays at 0:10 with a 3 s card");
    assert.match(
      guide?.comment ?? "",
      /LOW/,
      "a coarse sync is flagged on the guide for whoever opens the project",
    );

    const splits = computeSplits(match, match.players[0]!.uuid, match.players[1]!.uuid);
    const chapters = readFileSync(result.chaptersPath, "utf8");
    // P12: export:fast cuts headTrimSec(card) = 4 s, so match start is at 0:06 in the MP4.
    assert.equal(10 - headTrimSec(3), 6);
    assert.equal(
      chapters,
      formatChapters(buildChapters(splits, match, 10 - headTrimSec(3))),
      "chapters agree with the MP4 the kept card will produce",
    );
    // P11: the handbook's wording — headTrimSec(config.introSec), not the card's.
    deviation(
      "handbook Known pitfalls, Timeline zero: the description's chapters take headTrimSec(config.introSec)",
      () =>
        assert.equal(
          chapters,
          formatChapters(buildChapters(splits, match, 10 - headTrimSec(config.introSec))),
          `with config.introSec ${config.introSec} and a kept 3 s card, chapters follow the card on disk (0:06), not config (0:10)`,
        ),
    );
    // The description carries the same chapter lines.
    const description = readFileSync(result.descriptionPath, "utf8");
    const firstSplit = chapters.split("\n")[1]!;
    assert.ok(description.includes(firstSplit), "the description's chapters are the chapters file's");
  }

  // =============================================================================================
  // C. P15: one VOD attached, the other remembered in vods.json from an earlier discovery. The
  // archive is "gone" (yt-dlp fails), and the match still renders without listing anything.
  {
    const full = fixture(13673240);
    const [kept, remembered] = full.vod;
    const match: MatchInfo = { ...full, vod: [kept!] };
    serve(match, true);
    const dir = stageMatch(match, CARD7);
    writeFileSync(path.join(dir, "vods.json"), JSON.stringify([remembered]));
    writeSyncOffsets(dir, { left: 20, right: 21, confidence: 1, detail: "hand", source: "manual" });
    const before = ytdlpCalls();

    const { result, error } = await run(String(match.id));
    assert.equal(error, undefined, `a remembered VOD keeps the match renderable: ${error?.message}`);
    assert.ok(result);
    assert.equal(ytdlpCalls(), before, "vods.json is read first: no archive listing");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(dir, "vods.json"), "utf8")),
      [remembered],
      "vods.json untouched",
    );
    const description = readFileSync(result.descriptionPath, "utf8");
    const rememberedId = remembered!.url.split("/").pop()!;
    assert.ok(description.includes(rememberedId), "the remembered VOD is the one the description links");
  }

  // =============================================================================================
  // D. P16: one VOD and nothing to find it by — the fetch stage fails, nothing is written.
  {
    const full = fixture(13766294);
    const match: MatchInfo = { ...full, vod: [full.vod[0]!] };
    serve(match); // no Twitch connection: discovery has nothing to list
    const { events, error } = await run(String(match.id));
    assert.ok(error, "one VOD is not enough");
    assert.match(error.message, /1\/2 VODs/);
    assert.deepEqual(
      terminal(events).map((e) => [e.stage, e.status]),
      [["fetch", "error"]],
      "the failure settles on the fetch stage and no later stage starts",
    );
    assert.match(terminal(events)[0]!.message ?? "", /1\/2 VODs/, "the error reaches the stage line");
    const dir = path.join(config.mediaDir, String(match.id));
    assert.ok(!existsSync(path.join(dir, "sync.json")), "a failed fetch writes no sync decision");
    assert.ok(!existsSync(path.join(dir, `match-${match.id}.kdenlive`)));
  }

  // =============================================================================================
  // P3: the manifest is the "render finished" mark — the pipeline's reuse reads it through
  // readSplitStills, so a directory without a usable one is not a finished render.
  {
    const dir = mkdtempSync(path.join(root, "manifest-"));
    const still = path.join(dir, "overlay-splits-0.png");
    writeFileSync(still, "png");
    assert.equal(await readSplitStills(dir), null, "stills without the manifest are an unfinished render");
    // A killed run's half-written manifest stays under .part (atomicOutput) and is never read.
    writeFileSync(
      path.join(dir, SPLITS_MANIFEST.replace(/\.json$/, ".part.json")),
      JSON.stringify([{ path: still, startSec: 0, durationSec: 5 }]),
    );
    assert.equal(await readSplitStills(dir), null, "a .part manifest is not a finished render");
    writeFileSync(
      overlayPaths(dir).manifest,
      JSON.stringify([
        { path: still, startSec: 0, durationSec: 5 },
        { path: path.join(dir, "overlay-splits-1.png"), startSec: 5, durationSec: 5 },
      ]),
    );
    assert.equal(
      await readSplitStills(dir),
      null,
      "a manifest naming a missing still is not a finished render",
    );
    writeFileSync(overlayPaths(dir).manifest, '[{"path":');
    assert.equal(await readSplitStills(dir), null, "a truncated manifest is not a finished render");
    writeFileSync(overlayPaths(dir).manifest, JSON.stringify([{ path: still, startSec: 0, durationSec: 5 }]));
    assert.deepEqual(await readSplitStills(dir), [{ path: still, startSec: 0, durationSec: 5 }]);
  }
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = savedMediaDir;
  rmSync(root, { recursive: true, force: true });
}

if (deviations.length > 0) console.log(`pipeline.contract: ${deviations.length} deviation(s) reported`);
console.log("pipeline.contract: all checks passed");
