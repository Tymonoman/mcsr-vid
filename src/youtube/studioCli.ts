/**
 * npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login [--profile-dir=<path>]
 *   | endscreen <matchId|videoId> [--dry-run] | tc <matchId|videoId> title <title…> [--dry-run]
 *   | tc <matchId|videoId> thumbnail <file…> [--dry-run] | tc-read <matchId|videoId>
 *   | worker [--once] [--dry-run] | tc-plan <plan.json>
 *   | related <shortId> <longFormId>
 *
 * probe: starts Chrome, loads Studio, prints what it found, stops.
 * pin: pins the channel's own first comment on a video — by match id (reads its recorded
 *      videoId) or by the video id directly (resolved back to a match for its screenshots).
 * login: the same one-time login screen the dashboard's YouTube panel offers, from the terminal —
 *      prints the URL and password, waits for Enter, then probes and stops.
 * endscreen/tc/tc-read: the same single-video actions the worker's cycle runs, for a manual,
 *      targeted test on one named video — never gated on `config.studioAutomation` (see `pin`
 *      above; these are the operator's own terminal presses, same as `pin`'s own dry-run step in
 *      its setup instructions). `tc`'s mode is `title` (one or more challenger titles) or
 *      `thumbnail` (2-3 challenger file paths).
 * worker: the phase 2/3 loop (src/youtube/studioWorker.ts) — end screens, then Test & Compare
 *      starts and daily checks, one browser session per cycle, ~20 min apart. `--once` runs a
 *      single cycle and exits (what this is tested with); without it the process runs forever,
 *      meant for `nohup`. A no-op, reported as `"skipped"`, unless `--enable` (or env
 *      `STUDIO_WORKER=1`) is given or `config.studioAutomation` is on (see studioWorker.ts's own
 *      top comment) — this loop runs in the Claude container, not the dashboard's, so the
 *      dashboard's own flag staying `false` does not have to stop it.
 * tc-plan: turns an approved judge's plan (tc-plan.json's own shape) into planned "tc" experiments
 *      in `<mediaDir>/.experiments.json` — idempotent, prints what it added and what it skipped
 *      and why. Opens no browser.
 * related: checks a Short's "Related video" field against its own long-form — confirmed-empty
 *      on this profile today (CLAUDE.md's "Studio automation" → "Related video"), so this only
 *      ever opens the picker, searches, and reports `"already-linked"`/`"picker-empty"`/an error;
 *      it never selects or saves anything. No `--dry-run`: there is nothing destructive to stop
 *      short of yet.
 *
 * `--profile-dir=<path>` overrides the real `/home/node/.studio-profile` on probe/pin/login/worker
 * — ad hoc testing against a throwaway profile without ever touching the operator's actual login.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readUpload, resolveShortVideoId, videoIdOwner } from "./youtubeStore.js";
import {
  addEndScreenFromTemplate,
  checkRelatedVideoPicker,
  pinComment,
  readTestAndCompare,
  startTestAndCompare,
  type TcTest,
} from "./studioActions.js";
import {
  probe,
  readLastProbe,
  start,
  startAndProbe as startAndProbeShared,
  type StudioHandle,
} from "./studioBrowser.js";
import { finishLogin, startLogin } from "../dashboard/studioLogin.js";
import { importTcPlan, type TcPlan } from "./studioExperiments.js";
import { END_SCREEN_TEMPLATE_VIDEO_ID, runWorker } from "./studioWorker.js";

const [command, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith("--"));
const dryRun = rest.includes("--dry-run");
const profileDirArg = rest.find((a) => a.startsWith("--profile-dir="))?.slice("--profile-dir=".length);
const startOpts = profileDirArg ? { profileDir: profileDirArg } : {};

function usage(): never {
  console.error(
    "usage: npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login [--profile-dir=<path>]" +
      " | endscreen <matchId|videoId> [--dry-run]" +
      " | tc <matchId|videoId> title|thumbnail <variant…> [--dry-run] | tc-read <matchId|videoId>" +
      " | worker [--once] [--dry-run] [--enable] | tc-plan <plan.json>" +
      " | related <shortId|matchId> <longFormVideoId>",
  );
  process.exit(2);
}

async function probeCmd(): Promise<void> {
  const handle = await start(startOpts);
  try {
    const { result, url, title } = await probe(handle);
    console.log(`${result}: ${title} (${url})`);
    if (result !== "ok") process.exitCode = 1;
  } finally {
    await handle.stop();
  }
}

/** Resolves a CLI target to its matchId/videoId pair, by match id (its recorded upload) or by
 * video id directly (resolved back to a match for screenshots) — the lookup `pin` always did,
 * now shared with `endscreen`/`tc`/`tc-read`. */
async function resolveVideo(target: string | undefined): Promise<{ matchId: number; videoId: string }> {
  if (!target) usage();
  if (/^\d+$/.test(target)) {
    const matchId = Number(target);
    const record = await readUpload(matchId, "video");
    if (!record) {
      console.error(`match ${matchId} has no recorded upload (youtube.json) — nothing to do`);
      process.exit(1);
    }
    return { matchId, videoId: record.videoId };
  }
  const owner = await videoIdOwner(target);
  if (!owner) {
    console.error(`${target} is not a known video id (no match records it in youtube.json)`);
    process.exit(1);
  }
  return { matchId: owner.matchId, videoId: target };
}

/** Prints and returns null on anything but `ok`; the actual start-probe-stop-on-failure shape
 * lives in `studioBrowser.ts` (`startAndProbe`), shared with anything else that wants it, and
 * fixed there 8 Oct 2026 to stop Chrome when `probe()` itself throws, not only on a non-`ok`
 * result — this CLI-local wrapper used to be the leaky version; see that function's own comment. */
async function startAndProbe(): Promise<StudioHandle | null> {
  const handle = await startAndProbeShared(startOpts);
  if (!handle) {
    const last = readLastProbe();
    console.error(last ? `Studio ${last.result}: ${last.message}` : "Studio probe failed");
    process.exitCode = 1;
  }
  return handle;
}

async function pinCmd(target: string | undefined): Promise<void> {
  const { matchId, videoId } = await resolveVideo(target);
  const handle = await startAndProbe();
  if (!handle) return;
  try {
    const outcome = await pinComment(handle, videoId, { matchId, dryRun });
    if (typeof outcome === "object") {
      console.error(`error: ${outcome.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${outcome}${dryRun ? " (dry run — stopped before the confirm click)" : ""}`);
  } finally {
    await handle.stop();
  }
}

async function endscreenCmd(target: string | undefined): Promise<void> {
  const { matchId, videoId } = await resolveVideo(target);
  const handle = await startAndProbe();
  if (!handle) return;
  try {
    const outcome = await addEndScreenFromTemplate(handle, videoId, END_SCREEN_TEMPLATE_VIDEO_ID, {
      matchId,
      dryRun,
    });
    if (typeof outcome === "object") {
      console.error(`error: ${outcome.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${outcome}${dryRun ? " (dry run — stopped before the save click)" : ""}`);
  } finally {
    await handle.stop();
  }
}

async function tcCmd(
  target: string | undefined,
  kind: string | undefined,
  variants: string[],
): Promise<void> {
  if (kind !== "title" && kind !== "thumbnail") usage();
  const { matchId, videoId } = await resolveVideo(target);
  const test: TcTest =
    kind === "title" ? { kind: "title", titles: variants } : { kind: "thumbnail", files: variants };
  const handle = await startAndProbe();
  if (!handle) return;
  try {
    const outcome = await startTestAndCompare(handle, videoId, test, { matchId, dryRun });
    if (typeof outcome === "object") {
      console.error(`error: ${outcome.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${outcome}${dryRun ? " (dry run — stopped before the set-test click)" : ""}`);
  } finally {
    await handle.stop();
  }
}

async function tcReadCmd(target: string | undefined): Promise<void> {
  const { videoId } = await resolveVideo(target);
  const handle = await startAndProbe();
  if (!handle) return;
  try {
    const read = await readTestAndCompare(handle, videoId);
    if ("error" in read) {
      console.error(`error: ${read.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${read.state}${read.winner ? ` (${read.winner})` : ""}`);
  } finally {
    await handle.stop();
  }
}

async function loginCmd(): Promise<void> {
  const started = await startLogin(process.env.STUDIO_VNC_HOST ?? "localhost", startOpts);
  if ("error" in started) {
    console.error(started.error);
    process.exit(1);
  }
  console.log(`url: ${started.url}`);
  console.log(`password: ${started.password}`);
  console.log(`expires: ${started.expiresAt}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Sign in over that screen, then press Enter here… ");
  rl.close();
  const done = await finishLogin();
  if ("error" in done) {
    console.error(done.error);
    process.exit(1);
  }
  console.log(`${done.result}: ${done.message}`);
  if (done.result !== "ok") process.exitCode = 1;
}

async function workerCmd(): Promise<void> {
  const once = rest.includes("--once");
  // See studioWorker.ts's own top-of-file comment: `config.studioAutomation` alone must not start
  // a real Chrome here — that flag is the dashboard's own switch, and the dashboard container has
  // no Chrome at all. Starting this loop for real needs the operator's own browser-automation
  // grant exercised directly, by whoever runs this command passing `--enable` (or setting
  // `STUDIO_WORKER=1` for a `nohup`'d session that cannot pass a flag after the fact).
  const enable = rest.includes("--enable") || process.env.STUDIO_WORKER === "1";
  await runWorker({ once, dryRun, startOpts, enable });
}

/** `related`'s own target resolution: a Short, by match id (its recorded `youtube-short.json`)
 * or by its video id directly — mirrors `resolveVideo` above, but reads the short record, not
 * the long-form's (there is no shared helper for "which kind" because every other command here
 * only ever means the long-form). The actual kind check — refusing a long-form id pasted or
 * swapped in where a Short's was expected — lives in `youtubeStore.ts`'s `resolveShortVideoId`,
 * where it has a real unit test; this is just the CLI's exit-on-error wrapper around it. */
async function resolveShort(target: string | undefined): Promise<{ matchId: number; shortId: string }> {
  if (!target) usage();
  const resolved = await resolveShortVideoId(target);
  if ("error" in resolved) {
    console.error(resolved.error);
    process.exit(1);
  }
  return resolved;
}

async function relatedCmd(shortTarget: string | undefined, longFormId: string | undefined): Promise<void> {
  if (!longFormId) usage();
  const { matchId, shortId } = await resolveShort(shortTarget);
  const handle = await startAndProbe();
  if (!handle) return;
  try {
    const outcome = await checkRelatedVideoPicker(handle, shortId, longFormId, { matchId });
    if (typeof outcome === "object") {
      console.error(`error: ${outcome.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(outcome);
  } finally {
    await handle.stop();
  }
}

async function tcPlanCmd(file: string | undefined): Promise<void> {
  if (!file) usage();
  const plan = JSON.parse(await readFile(file, "utf8")) as TcPlan;
  const { added, skipped } = await importTcPlan(plan);
  for (const exp of added) console.log(`planned ${exp.id} (${exp.arms.length} arms)`);
  for (const s of skipped) console.log(`skipped ${s.videoId} (${s.kind}): ${s.reason}`);
  console.log(`${added.length} planned, ${skipped.length} skipped`);
}

switch (command) {
  case "probe":
    await probeCmd();
    break;
  case "pin":
    await pinCmd(args[0]);
    break;
  case "login":
    await loginCmd();
    break;
  case "endscreen":
    await endscreenCmd(args[0]);
    break;
  case "tc":
    await tcCmd(args[0], args[1], args.slice(2));
    break;
  case "tc-read":
    await tcReadCmd(args[0]);
    break;
  case "worker":
    await workerCmd();
    break;
  case "tc-plan":
    await tcPlanCmd(args[0]);
    break;
  case "related":
    await relatedCmd(args[0], args[1]);
    break;
  default:
    usage();
}
