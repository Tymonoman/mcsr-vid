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
//      manifest, or a manifest naming a still not on disk, is not a finished render (a killed
//      run's `.part` manifest is atomicOutput.contract.test.ts's A5).
//  P4  Timeline zero is the countdown's first second: the project places each POV by sync.json's
//      numbers, so match start lands at exactly ANCHOR_SEC (10 s) on the timeline, and the
//      overlay layers sit at timeline 0 untrimmed (CLAUDE.md).
//  P5–P8 are pinned by src/pipeline/pipeline.contract.test.ts (the sync stage alone):
//  P5  sync.json is written when the sync stage decides, `source` says which — its P3.
//  P6  A manual sync is kept by a re-run — its P6.
//  P7  An unreadable clip keeps the coarse estimate at confidence 0, as a warning — its P2.
//  P8  A re-run that keeps the same sync leaves the export fresh — its P14. Only the other half
//      lives here (section E): a real correction after export is stale, and the refusal names
//      the fix.
//  P9  The finished MP4 is not the timeline: `exportMatchStartSec(dir, id)` reads
//      `final-<id>.json`, and is 10 without a record, which is what a fresh generate-project
//      leaves (CLAUDE.md, handbook).
//  P10 Kdenlive stays at 0:10 whatever the card length; `export:fast` alone cuts `headTrimSec`
//      (CLAUDE.md "overlay-intro.webm").
//  P11 A match keeps the card it was rendered with: export:fast takes the card's length from the
//      file (handbook "overlay-intro.webm"), and the description's chapters, written at render
//      time, take `headTrimSec` of that same card — so they agree with where the export puts
//      match start (handbook "Timeline zero").
//  P12 Generated projects carry `<mlt root>` with every resource relative to it (CLAUDE.md).
//  P13 The write stage leaves `.kdenlive`, title, description, chapters and tags (one per line)
//      beside the clips (README mermaid "write"), at absolute paths in the result.
//  P14 A VOD found once is remembered in `vods.json` and read back first, so a clip on disk stays
//      renderable after the archive is gone — no re-listing (handbook "A Twitch archive").
//  P15 Both VODs are needed: a match with one, attached or found, fails the fetch stage with the
//      "1/2 VODs" error and writes nothing (handbook; pipeline.ts).
//  P16 The chat save is best effort: a Twitch failure never fails the pipeline (README "+ chat").
//  P17 Nothing names the winner — no result line in the description, title, tags or chapters
//      (CLAUDE.md house rules).
//
// Hermetic: a temp mediaDir, every fetch mocked (no network), a fake `yt-dlp` first on PATH that
// records any call, tiny ffmpeg-made clips (well under 2 s), no Remotion/Chromium.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/pipeline/pipeline.stages.contract.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { overlayPaths, readSplitStills } from "./overlayRender.js";
import { variantFile } from "../thumbnails/thumbnailVariants.js";
import { buildChapters, formatChapters } from "./chapters.js";
import { computeSplits } from "./overlayProps.js";

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

// Tiny real media, made once (A–C, below): ffprobe has to read every duration the write stage asks for.
const ffmpeg = (...args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { timeout: 60_000, stdio: "ignore" });
const media = path.join(root, "template");
mkdirSync(media);
const POV = path.join(media, "pov.mp4");
const TIMER = path.join(media, "timer.mp4");
const cardOf = (sec: number): string => {
  const file = path.join(media, `intro-${sec}.webm`);
  ffmpeg(
    ...["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", String(sec)],
    ...["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", file],
  );
  return file;
};

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

// A's match and its hand fix; E reads the same directory after its export.
const matchA = fixture(12929221);
const manual = {
  left: 12.5,
  right: 13.25,
  confidence: 1,
  detail: "hand-matched countdowns",
  source: "manual" as const,
};

try {
  // A–C run the real pipeline on real clips: ffmpeg makes them and the write stage's ffprobe reads
  // them back. A box without both (CI's runner) skips them out loud; E, D and P3 need neither.
  if (spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) {
    console.log("SKIP: stages A–C, the pipeline run on real clips (no ffmpeg/ffprobe on PATH)");
  } else {
    // 160 s, so the coarse estimate (preRollSec = 150) still leaves the clip a tail on the timeline.
    ffmpeg(
      ...["-f", "lavfi", "-i", "color=c=black:s=320x180:r=1", "-t", "160"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", POV],
    );
    ffmpeg(
      ...["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1", "-t", "30"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", TIMER],
    );
    const CARD7 = cardOf(7);
    const CARD3 = cardOf(3);

    // =============================================================================================
    // A. A finished render on disk with a hand-fixed sync: every stage reuses, the hand fix stands.
    {
      const match = matchA;
      serve(match);
      const dir = stageMatch(match, CARD7);
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
      // P16: the chat fetch failed (no network) and the run still finished; no chat file pretends.
      assert.ok(
        fetchLog.some((u) => /twitch\.tv/.test(u)),
        "the chat save was attempted",
      );
      assert.ok(!readdirSync(dir).some((f) => f.startsWith("chat-")), "a failed chat save writes no file");

      // P13: the write stage's artifacts, at absolute paths, beside the clips.
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

      // P4: the project places each POV by sync.json's (hand-fixed) numbers, so match start sits at
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

      // P12: <mlt root> is the match directory and no resource carries an absolute path.
      assert.match(
        xml,
        new RegExp(`<mlt root="${path.resolve(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      );
      const absolute = resourcesOf(xml).filter((r) => path.isAbsolute(r));
      assert.deepEqual(absolute, [], "every resource is relative to <mlt root>");
      assert.ok(
        resourcesOf(xml).some((r) => r === `${match.players[0]!.nickname}.mp4`),
        "a POV clip resolves under root",
      );

      // P11: a 7 s card cuts nothing, so chapters count match start from 0:10.
      const splits = computeSplits(match, match.players[0]!.uuid, match.players[1]!.uuid);
      const chapters = readFileSync(result.chaptersPath, "utf8");
      assert.equal(chapters, formatChapters(buildChapters(splits, match, 10)));
      assert.match(chapters, /^0:00 Start\n/, "YouTube needs the first chapter at 0:00");

      // P17: no written text names the winner as such.
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
      // A result line need not use a result word ("X finished first"): every description line that
      // names the winner alone must have a twin, same words bar the link, naming the other player.
      const loser = match.players.find((p) => p.uuid !== match.result.uuid)!.nickname;
      const lines = readFileSync(result.descriptionPath, "utf8").split("\n");
      const shape = (l: string, name: string) =>
        l.replaceAll(name, "<player>").replace(/https?:\/\/\S+/g, "<url>");
      const alone = (a: string, b: string) => lines.filter((l) => l.includes(a) && !l.includes(b));
      const twins = new Set(alone(loser, winner).map((l) => shape(l, loser)));
      for (const line of alone(winner, loser)) {
        assert.ok(twins.has(shape(line, winner)), `"${line}" names the winner alone`);
      }
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

      // The coarse sync.json itself is pipeline.contract.test.ts's P2/P3; here, past the sync
      // stage's warning the run carries on to the project.
      assert.equal(settled(events, "write")!.status, "done", "an unread countdown does not stop the run");
      const sync = readSyncOffsets(dir)!;

      // P4 + P10: the project places by sync.json and still puts match start at 0:10 — a 3 s card
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
      // P11: export:fast cuts headTrimSec(card) = 4 s, so match start is at 0:06 in the MP4 — and
      // the chapters follow the card on disk, whatever config.introSec says now.
      assert.equal(10 - headTrimSec(3), 6);
      assert.equal(
        chapters,
        formatChapters(buildChapters(splits, match, 10 - headTrimSec(3))),
        "chapters agree with the MP4 the kept card will produce",
      );
      // The description carries the same chapter lines.
      const description = readFileSync(result.descriptionPath, "utf8");
      const firstSplit = chapters.split("\n")[1]!;
      assert.ok(description.includes(firstSplit), "the description's chapters are the chapters file's");
    }

    // =============================================================================================
    // C. P14: one VOD attached, the other remembered in vods.json from an earlier discovery. The
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
  }

  // =============================================================================================
  // E. A's match after its export. P8's other half (a re-run that keeps the sync stays fresh) is
  // pipeline.contract.test.ts's P14: a real correction after the export is stale, and the refusal
  // names the fix. Plain files only, so it runs whether or not A did (A's directory, else a bare one).
  {
    const match = matchA;
    const dir = path.join(config.mediaDir, String(match.id));
    mkdirSync(dir, { recursive: true });
    const final = path.join(dir, `final-${match.id}.mp4`);
    writeFileSync(final, "mp4");
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(final, hourAgo, hourAgo);
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
    // Raw text: 1e309 parses to Infinity, which JSON.stringify would have written as null.
    for (const bad of ["-4", '"6"', "null", "1e309"]) {
      writeFileSync(path.join(dir, `final-${match.id}.json`), `{"matchStartSec": ${bad}}`);
      assert.equal(exportMatchStartSec(dir, match.id), 10, `matchStartSec ${bad} falls back to 10`);
    }
    writeFileSync(path.join(dir, `final-${match.id}.json`), "{}");
    assert.equal(exportMatchStartSec(dir, match.id), 10, "a record without the field falls back to 10");
  }

  // =============================================================================================
  // D. P15: one VOD and nothing to find it by — the fetch stage fails, nothing is written.
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

console.log("pipeline.stages.contract: all checks passed");
