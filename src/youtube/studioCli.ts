/**
 * npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login
 *
 * probe: starts Chrome, loads Studio, prints what it found, stops.
 * pin: pins the channel's own first comment on a video — by match id (reads its recorded
 *      videoId) or by the video id directly (resolved back to a match for its screenshots).
 * login: the same one-time login screen the dashboard's YouTube panel offers, from the terminal —
 *      prints the URL and password, waits for Enter, then probes and stops.
 */
import { createInterface } from "node:readline/promises";
import { readUpload } from "./youtubeStore.js";
import { videoIdOwner } from "./youtubeStore.js";
import { pinComment } from "./studioActions.js";
import { probe, start } from "./studioBrowser.js";
import { finishLogin, startLogin } from "../dashboard/studioLogin.js";

const [command, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith("--"));
const dryRun = rest.includes("--dry-run");

function usage(): never {
  console.error("usage: npm run studio -- probe | pin <matchId|videoId> [--dry-run] | login");
  process.exit(2);
}

async function probeCmd(): Promise<void> {
  const handle = await start();
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
  const handle = await start();
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
  const started = await startLogin(process.env.STUDIO_VNC_HOST ?? "localhost");
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
  default:
    usage();
}
