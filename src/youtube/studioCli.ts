/**
 * npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login [--profile-dir=<path>]
 *   | worker [--once] [--dry-run] | tc-plan <plan.json>
 *
 * probe: starts Chrome, loads Studio, prints what it found, stops.
 * pin: pins the channel's own first comment on a video — by match id (reads its recorded
 *      videoId) or by the video id directly (resolved back to a match for its screenshots).
 * login: the same one-time login screen the dashboard's YouTube panel offers, from the terminal —
 *      prints the URL and password, waits for Enter, then probes and stops.
 * worker: the phase 2/3 loop (src/youtube/studioWorker.ts) — end screens, then Test & Compare
 *      starts and daily checks, one browser session per cycle, ~20 min apart. `--once` runs a
 *      single cycle and exits (what this is tested with); without it the process runs forever,
 *      meant for `nohup`. A no-op, reported as `"skipped"`, while `config.studioAutomation` is off.
 * tc-plan: turns an approved judge's plan (tc-plan.json's own shape) into planned "tc" experiments
 *      in `<mediaDir>/.experiments.json` — idempotent, prints what it added and what it skipped
 *      and why. Opens no browser.
 *
 * `--profile-dir=<path>` overrides the real `/home/node/.studio-profile` on probe/pin/login/worker
 * — ad hoc testing against a throwaway profile without ever touching the operator's actual login.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readUpload } from "./youtubeStore.js";
import { videoIdOwner } from "./youtubeStore.js";
import { pinComment } from "./studioActions.js";
import { probe, start } from "./studioBrowser.js";
import { finishLogin, startLogin } from "../dashboard/studioLogin.js";
import { importTcPlan, type TcPlan } from "./studioExperiments.js";
import { runWorker } from "./studioWorker.js";

const [command, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith("--"));
const dryRun = rest.includes("--dry-run");
const profileDirArg = rest.find((a) => a.startsWith("--profile-dir="))?.slice("--profile-dir=".length);
const startOpts = profileDirArg ? { profileDir: profileDirArg } : {};

function usage(): never {
  console.error(
    "usage: npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login [--profile-dir=<path>]" +
      " | worker [--once] [--dry-run] | tc-plan <plan.json>",
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

async function pinCmd(target: string | undefined): Promise<void> {
  if (!target) usage();
  let matchId: number;
  let videoId: string;
  if (/^\d+$/.test(target)) {
    matchId = Number(target);
    const record = await readUpload(matchId, "video");
    if (!record) {
      console.error(`match ${matchId} has no recorded upload (youtube.json) — nothing to pin`);
      process.exit(1);
    }
    videoId = record.videoId;
  } else {
    const owner = await videoIdOwner(target);
    if (!owner) {
      console.error(`${target} is not a known video id (no match records it in youtube.json)`);
      process.exit(1);
    }
    matchId = owner.matchId;
    videoId = target;
  }
  const handle = await start(startOpts);
  try {
    const probed = await probe(handle);
    if (probed.result !== "ok") {
      console.error(`Studio ${probed.result}: ${probed.title} (${probed.url})`);
      process.exitCode = 1;
      return;
    }
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
  await runWorker({ once, dryRun, startOpts });
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
  case "worker":
    await workerCmd();
    break;
  case "tc-plan":
    await tcPlanCmd(args[0]);
    break;
  default:
    usage();
}
