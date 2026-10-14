// Contract test for the sync feature, written from the docs (CLAUDE.md "Known pitfalls", the
// handbook's long form of it, README) by an outside engineer, through the dashboard's own routes.
// Run: npx tsx src/dashboard/syncRoutes.contract.test.ts
//
// What the docs promise about sync (the P-numbers are shared by every *.contract.test.ts of it):
//
//  P1  Sync reads the picture, and only the picture: each POV clip is anchored on its own
//      countdown reading (digit or camera freeze); no audio fallback. (sync.contract)
//  P2  A clip the picture cannot read keeps the coarse estimate at confidence 0, and the
//      dashboard's sync editor settles it. (sync.contract)
//  P3  The pipeline writes <matchDir>/sync.json when the sync stage decides — refined or
//      kept-coarse — and `source` says which. (pipeline.contract)
//  P4  Saving in the hand editor (PUT /api/sync/:id) stamps source "manual", confidence 1.  (here)
//  P5  A manual save clears the low-confidence warning line.                                 (here)
//  P6  A manual sync makes the sync stage keep those numbers on a re-render instead of
//      re-running the detector. (pipeline.contract)
//  P7  Only the clip placement changes on a save: the fix is export:fast, not a re-render.   (here)
//  P8  A sync.json correction after export leaves the export stale until re-encoded
//      (`exportStale`: mtime of sync.json vs the export).                                     (here)
//  P9  exportStale refuses Upload / the nightly / adopt with one line. (youtubeRoutes.contract;
//      Upload's refusal is already pinned in youtubeUpload.test.ts)
//  P10 Every consumer places clips from sync.json; without it export:fast and the Short fall
//      back to config.preRollSec. (here: the editor's own fallback; generateShort.contract)
//  P11 `npm run sync-status -- <id>` derives sync.json from the .kdenlive and writes it; with no
//      id it lists every match and writes nothing. (syncStatusCli.contract)
//  P12 GET /api/sync/frame?match=&side=&t=&offset= is one frame out of a POV clip at a second of
//      the finished timeline, at clip time `offset + (t - ANCHOR_SEC)` — the only arithmetic. (here)
//  P13 Timeline zero is the countdown's first second: match start is at 10 s on the timeline,
//      and the sync check looks at both POVs at 9.6 s.                                        (here)
//  P14 A re-render that corrects nothing must not make the export stale (P6 + P8: only "a
//      sync.json correction after export" does). (pipeline.contract)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { ANCHOR_SEC } from "../pipeline/kdenliveProject.js";
import { clipTimeFor } from "../pipeline/syncEdit.js";
import { readSyncOffsets, staleExportMessage, syncFilePath, writeSyncOffsets } from "../pipeline/syncFile.js";
import { matchStatusFor } from "./matchStatus.js";
import { handleSyncRoute } from "./syncRoutes.js";

/** Keeps the docs' wording where the code differs; prints it and carries on until triage. */
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const ID = 12730175; // edcr vs doogile, a real ranked match (src/fixtures)
const fixture = readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8");
const media = mkdtempSync(path.join(tmpdir(), "sync-routes-contract-"));
config.mediaDir = media;

// Hermetic: the MCSR API answers from the fixture; anything else reaching the network fails the test.
const offline: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.mcsrranked.com" && url.pathname === `/matches/${ID}`)
    return new Response(`{"status":"success","data":${fixture}}`);
  offline.push(String(url));
  throw new Error(`no network in a contract test: ${url}`);
}) as typeof fetch;

/** Mirrors server.ts: ids come from the URL and gate a path join. */
const parseId = (raw: string | undefined): number | null =>
  raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;

interface Answer {
  handled: boolean;
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON payload
  headers: Record<string, string>;
  bytes: Buffer;
}
async function call(method: string, url: string, body = ""): Promise<Answer> {
  const out: Answer = { handled: false, status: 0, body: undefined, headers: {}, bytes: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(chunk?: Buffer | string) {
      out.bytes = Buffer.from(chunk ?? "");
    },
  } as unknown as ServerResponse;
  const segments = new URL(url, "http://x").pathname.split("/").filter(Boolean);
  out.handled = await handleSyncRoute({ method, url } as IncomingMessage, res, segments, {
    json: (_res, status, payload) => {
      out.status = status;
      out.body = payload;
    },
    readBody: async () => body,
    matchDir,
    parseId,
  });
  return out;
}

const dir = matchDir(ID);
mkdirSync(dir, { recursive: true });
const at = (file: string, ms: number) => utimesSync(file, new Date(ms), new Date(ms));
const now = Date.now();

try {
  // --- P10 / P13: before anything synced, the editor starts on the coarse estimate --------------
  {
    const r = await call("GET", `/api/sync/${ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.sync, null, "no sync.json yet");
    // P10: without sync.json a consumer places the clips at config.preRollSec; the editor shows
    // the operator exactly that number, or the first nudge would start from somewhere else.
    assert.equal(r.body.fallback, config.preRollSec);
    // P13: match start sits at 10 s on the timeline — the countdown's ten seconds come first.
    assert.equal(r.body.anchorSec, 10);
    assert.equal(ANCHOR_SEC, 10);
    // No export, nothing to be stale against (P8 needs an export to compare with).
    assert.equal(r.body.exported, false);
    assert.equal(r.body.syncStale, false);
    assert.equal(r.body.staleMessage, null);
  }

  // A rendered, exported match: the detector was unsure, the export came after it.
  for (const f of ["overlay-timer.mp4", "overlay-top.png", "overlay-intro.webm", "overlay-splits.json"])
    writeFileSync(path.join(dir, f), f === "overlay-splits.json" ? "[]" : "render output");
  writeSyncOffsets(dir, {
    left: 150,
    right: 151.4,
    confidence: 0.12,
    detail: "video: one countdown found",
    source: "countdown",
  });
  at(syncFilePath(dir), now - 120_000);
  const final = path.join(dir, `final-${ID}.mp4`);
  writeFileSync(final, "the export");
  at(final, now - 60_000);
  const renderMtimes = () =>
    ["overlay-timer.mp4", "overlay-top.png", "overlay-intro.webm", "overlay-splits.json"].map(
      (f) => statSync(path.join(dir, f)).mtimeMs,
    );
  const renderedAt = renderMtimes();

  {
    const r = await call("GET", `/api/sync/${ID}`);
    assert.equal(r.body.exported, true);
    // P8: the export read this sync.json (it is older than the export) — nothing to re-encode.
    assert.equal(r.body.syncStale, false, "an export made after its sync is fresh");
    // P5's other half: a weak reading IS below the line, so the warning shows before the fix.
    assert.ok(r.body.sync.confidence < r.body.threshold, "the detector's 12% reading is a warning");
  }

  // --- P4 / P5 / P7 / P8: the operator fixes it by hand ----------------------------------------
  {
    // A bad box is refused and stamps nothing: "manual" must mean a human's numbers, not a NaN.
    const bad = await call("PUT", `/api/sync/${ID}`, JSON.stringify({ left: "", right: 148.5 }));
    assert.equal(bad.status, 400);
    assert.equal(
      readSyncOffsets(dir)?.source,
      "countdown",
      "a refused save leaves the detector's file alone",
    );

    const r = await call("PUT", `/api/sync/${ID}`, JSON.stringify({ left: 153.25, right: "148.5" }));
    assert.equal(r.status, 200);
    const onDisk = readSyncOffsets(dir);
    // P4: saving stamps source "manual" and confidence 1, with the operator's own numbers —
    // read back from the file every consumer reads (P10), not just from the answer.
    assert.equal(onDisk?.source, "manual");
    assert.equal(onDisk?.confidence, 1);
    assert.equal(onDisk?.left, 153.25);
    assert.equal(onDisk?.right, 148.5, "a typed string is the same number");
    assert.deepEqual(r.body.sync, onDisk, "the answer is what was written");
    // P5: a manual sync clears the warning line, which keys off confidence vs the threshold.
    assert.ok(r.body.sync.confidence >= r.body.threshold, "confidence 1 is never a warning");
    assert.ok(onDisk!.confidence >= config.syncConfidenceThreshold);
    // P8: the save is exactly what makes the earlier export stale — the incident in the docs, a
    // video that went out of sync because sync.json was corrected after final-<id>.mp4.
    assert.equal(r.body.syncStale, true, "a correction after export leaves the export stale");
    // P9: refused with one line, and that line names the fix.
    assert.equal(r.body.staleMessage, staleExportMessage(ID));
    assert.ok(!r.body.staleMessage.includes("\n"), "one line");
    assert.match(r.body.staleMessage, new RegExp(`export:fast -- ${ID}`));
    // P7: only the placement changed — the render outputs are untouched, and the match still
    // reports its render stage done, so the fix is an export, not a re-render.
    assert.deepEqual(renderMtimes(), renderedAt, "a save rewrites no render output");
    assert.equal((await matchStatusFor(ID)).stages.render, true, "render stays done after a save");
  }

  // --- P8: until re-encoded, and no longer -----------------------------------------------------
  {
    assert.equal((await call("GET", `/api/sync/${ID}`)).body.syncStale, true, "still stale on reload");
    at(final, Date.now() + 2_000); // export:fast ran after the save
    const r = await call("GET", `/api/sync/${ID}`);
    assert.equal(r.body.syncStale, false, "re-encoded after the fix: fresh");
    assert.equal(r.body.staleMessage, null);
  }

  // --- P12 / P13: one frame out of a POV clip, at offset + (t - ANCHOR_SEC) --------------------
  {
    assert.equal((await call("GET", "/api/sync/frame?match=abc&side=left&t=5")).status, 400);
    // No clip on disk: said out loud, naming whose.
    const missing = await call("GET", `/api/sync/frame?match=${ID}&side=right&t=5`);
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /doogile/);

    assert.ok(Math.abs(clipTimeFor(153.25, 9.6) - 152.85) < 1e-9, "0.4 s before match start, any offset");
    // The frame checks need a real clip and a real decode: without ffmpeg (CI's runner has none;
    // test:unit's other shell-outs skip themselves the same way) they are skipped, said out loud.
    if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
      console.log("SKIP: sync frame colours (no ffmpeg on PATH)");
    } else {
      // A 2 s POV clip: red for its first second, blue for its second.
      const clip = path.join(dir, "edcr.mp4"); // players[0] of the fixture: the left POV
      execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=64x36:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=blue:s=64x36:d=1:r=10",
      "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", clip,
    ]); // prettier-ignore
      const colourOf = (jpeg: Buffer): "red" | "blue" => {
        const [r, , b] = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "image2pipe",
            "-i",
            "-",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
          ],
          { input: jpeg },
        );
        return r! > b! ? "red" : "blue";
      };
      const frame = async (query: string) => {
        const r = await call("GET", `/api/sync/frame?match=${ID}&side=left&${query}`);
        assert.equal(r.status, 200, `frame ${query}: ${JSON.stringify(r.body)}`);
        assert.equal(r.headers["content-type"], "image/jpeg");
        // The same URL must answer differently once the offset is nudged: never a cached frame.
        assert.equal(r.headers["cache-control"], "no-store");
        return colourOf(r.bytes);
      };
      // An explicit offset: t = ANCHOR_SEC is match start, i.e. clip second 0.5 — red; one second
      // later on the timeline is clip second 1.5 — blue. Gets the sign wrong and these swap.
      assert.equal(await frame(`t=${ANCHOR_SEC}&offset=0.5`), "red");
      assert.equal(await frame(`t=${ANCHOR_SEC + 1}&offset=0.5`), "blue");
      // No offset in the query: the saved one is used (sync.json is what every consumer reads).
      writeSyncOffsets(dir, { left: 1.2, right: 1.2, confidence: 1, detail: "", source: "manual" });
      assert.equal(await frame(`t=${ANCHOR_SEC}`), "blue", "clip second 1.2");
      assert.equal(await frame(`t=${ANCHOR_SEC - 0.5}`), "red", "clip second 0.7");
      // P13: the sync check's 9.6 s is 0.4 s before match start in both clips — the last digit of
      // the countdown both players freeze through.
      assert.equal(await frame("t=9.6"), "red", "1.2 - 0.4 = clip second 0.8, still the first second");
    }
  }
} finally {
  rmSync(media, { recursive: true, force: true });
}

assert.deepEqual(offline, [], "nothing but the mocked MCSR API was asked for");
console.log("syncRoutes.contract: all checks passed");
