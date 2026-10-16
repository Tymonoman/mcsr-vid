// Adopt's blocked-player gate: a match archived off disk with the MCSR API down still names its
// players in the chats and the title (`blockedOnDisk`), and adopt refuses before any YouTube call;
// and the A/B tab's reach read. No network (Google faked), no /media. Run: npx tsx src/dashboard/youtubeRoutes.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { manifestPath } from "../thumbnails/thumbnailVariants.js";
import { handleYoutubeRoute, type YoutubeRouteContext } from "./youtubeRoutes.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-ytroutes-test-"));
const saved = {
  mediaDir: config.mediaDir,
  jobId: config.youtubeReportingJobId,
  blocked: config.blockedPlayers,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = media;
config.blockedPlayers = ["BeefSalad", "Aquacorde"];
// A token that exists (so the route group is "connected") and would refresh against Google.
const token = path.join(media, "token.json");
await writeFile(token, JSON.stringify({ refresh_token: "r", client_id: "c", client_secret: "s" }));
process.env.YOUTUBE_TOKEN_FILE = token;
// The MCSR API is down and Google is never reached: every fetch throws, and Google's are noted.
const realFetch = globalThis.fetch;
const google: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/google/i.test(url)) google.push(url);
  throw new Error("no network in this test");
}) as typeof fetch;

const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
const ctx: YoutubeRouteContext = {
  json: (_res, status, body) => void answers.push({ status, body: body as Record<string, unknown> }),
  readBody: async () => JSON.stringify({ videoId: "abcdefghijk" }),
  matchDir,
  parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
};
const adopt = async (matchId: number) => {
  google.length = 0;
  const handled = await handleYoutubeRoute(
    { method: "POST" } as IncomingMessage,
    {} as ServerResponse,
    ["api", "youtube", "adopt", String(matchId)],
    ctx,
  );
  assert.ok(handled);
  return answers.at(-1)!;
};
// Everything adopt asks for before it reaches YouTube, and no POV clips: archived to the NAS.
const archived = async (matchId: number, pair: string, extra: string[] = []) => {
  const dir = matchDir(matchId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `match-${matchId}.title.txt`), `HOOK | ${pair} | MCSR Ranked 1v1\n`);
  await writeFile(
    path.join(dir, `match-${matchId}.description.txt`),
    `https://mcsrranked.com/stats/matches/${matchId}\n`,
  );
  await writeFile(manifestPath(dir), JSON.stringify({ chosenBy: "operator", chosen: "a", variants: [] }));
  for (const f of extra) await writeFile(path.join(dir, f), "[]");
};

try {
  // The control: the same files with nobody blocked get past every refusal to Google's door.
  await archived(100, "doogile vs Feinberg");
  const open = await adopt(100);
  assert.equal(open.status, 502, `an unblocked match reaches YouTube: ${JSON.stringify(open.body)}`);
  assert.ok(google.length > 0, "the control did reach for Google");

  // The title's pair alone names a blocked runner: refused, and Google never asked.
  await archived(101, "BeefSalad vs doogile");
  const byTitle = await adopt(101);
  assert.equal(byTitle.status, 403, JSON.stringify(byTitle.body));
  assert.deepEqual(google, [], "no YouTube call for a blocked match");

  // A renamed runner: the title says someone else, the saved chat still says who it was.
  await archived(102, "Renamed vs doogile", ["chat-Aquacorde.json"]);
  const byChat = await adopt(102);
  assert.equal(byChat.status, 403, JSON.stringify(byChat.body));
  assert.deepEqual(google, [], "no YouTube call for a blocked match");

  console.log("OK: adopt's blocked gate reads the disk too");

  // The A/B tab sums every daily reach report the job holds, not the newest day alone (one CSV a
  // day: the newest reversed the two before it, and a CTR read from it flipped day to day).
  {
    const { writeUpload } = await import("../youtube/youtubeStore.js");
    config.youtubeReportingJobId = "fake-job";
    await mkdir(matchDir(200), { recursive: true });
    await writeUpload(200, {
      videoId: "vAAAAAAAAAA",
      uploadedAt: "2026-10-10T12:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: null,
      title: "t",
    });
    const days: Record<string, string> = {
      "20261011": "vAAAAAAAAAA,1000,0.10",
      "20261012": "vAAAAAAAAAA,1000,0.10",
      "20261013": "vAAAAAAAAAA,1000,0.01",
    };
    const json = (b: unknown): Response => new Response(JSON.stringify(b));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "tok", expires_in: 3600 });
      if (url.startsWith("https://youtubereporting.googleapis.com/v1/jobs/fake-job/reports"))
        return json({
          reports: Object.keys(days).map((d) => ({
            id: d,
            downloadUrl: `https://fake.invalid/csv/${d}`,
            endTime: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T23:59:59Z`,
          })),
        });
      if (url.startsWith("https://fake.invalid/csv/")) {
        const d = url.split("/").pop()!;
        return new Response(
          `date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n${d},UC,${days[d]}`,
        );
      }
      throw new Error(`no network in this test: ${url}`);
    }) as typeof fetch;
    await handleYoutubeRoute({ method: "GET" } as IncomingMessage, {} as ServerResponse, ["api", "youtube", "abtest"], ctx);
    const body = answers.at(-1)!.body as { rows: Array<{ impressions: number; ctr: number }>; impressionsError: unknown };
    assert.equal(body.impressionsError, null, JSON.stringify(body));
    assert.deepEqual(
      body.rows.map((r) => [r.impressions, Number(r.ctr.toFixed(3))]),
      [[3000, 0.07]],
      "three days summed, impression-weighted — not the newest day's 1,000 at 1%",
    );
    console.log("OK: the A/B tab sums every daily reach report, not the newest day alone");
  }
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.youtubeReportingJobId = saved.jobId;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
