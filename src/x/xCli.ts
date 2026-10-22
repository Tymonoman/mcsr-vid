/**
 * npm run x -- post <matchId> [--dry-run] [--via browser|api] | auto [--dry-run] [--via browser|api]
 *            | status | login | probe
 *
 * post: the one match's hand-cut Short to X (src/x/xPost.ts), or the reason it is refused.
 *      `--dry-run` prints the post and signs/clicks nothing, so it works before any login or key.
 *      Without the four API keys, or with `--via browser`, it goes through the signed-in browser
 *      (src/x/xBrowser.ts): the whole drive up to the Post button, then the click.
 * auto: what the worker/tick does — the newest public long-form not yet posted, at most one post
 *      a UTC day; the same `--via` rule picks the path.
 * status: the keys (names only, never values), both flags, the X profile and the browser's last
 *      probe/post/error (`.x-browser.json`), the last post and the next candidate.
 * login: the one-time X sign-in over the remote screen (the Studio login's own screen, on
 *      x.com/login in the X profile); prints url/password/expiry, waits for Enter, then probes.
 *      Nothing here ever types a password, answers 2FA or solves a CAPTCHA.
 * probe: start the browser on the X profile, load the timeline, print ok/signed-out/verify/error.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import { finishLogin, startLogin } from "../dashboard/studioLogin.js";
import { start } from "../youtube/studioBrowser.js";
import { isXConfigured, X_KEY_NAMES } from "./xApi.js";
import {
  describeOutcome,
  postMatchViaBrowser,
  probeX,
  X_LOGIN,
  X_PROFILE_DIR,
  xBrowserTick,
  xStartOpts,
} from "./xBrowser.js";
import { readXBrowserState } from "./xBrowserState.js";
import { autoPost, lastXPost, pickXCandidate, postMatch, XRefusal } from "./xPost.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const viaAt = args.indexOf("--via");
const viaArg = args.find((a) => a.startsWith("--via="))?.slice(6) ?? (viaAt >= 0 ? args[viaAt + 1] : undefined);
const [sub, ...subArgs] = args.filter(
  (a, i) => a !== "--dry-run" && !a.startsWith("--via") && (viaAt < 0 || i !== viaAt + 1),
);
const usage =
  "usage: npm run x -- post <matchId> [--dry-run] [--via browser|api] | auto [--dry-run] [--via browser|api] | status | login | probe";
const NOT_CONFIGURED = `X is not configured: set ${X_KEY_NAMES.join(", ")} in /app/.env (handbook/x-setup.md), or sign the browser in (npm run x -- login, handbook/x-browser-setup.md)`;

/** `--via` wins; else the API when its keys are there, else the browser once its profile exists
 * (`npm run x -- login`); with neither, the API path's own "not configured" answers. */
function viaBrowser(): boolean {
  if (viaArg === "browser") return true;
  if (viaArg === "api") return false;
  if (viaArg !== undefined) {
    console.error(usage);
    process.exit(2);
  }
  return !isXConfigured() && existsSync(X_PROFILE_DIR);
}

async function loginCmd(): Promise<void> {
  const started = await startLogin(process.env.STUDIO_VNC_HOST ?? "localhost", xStartOpts(), X_LOGIN);
  if ("error" in started) {
    console.error(started.error);
    process.exit(1);
  }
  console.log(`url: ${started.url}`);
  console.log(`password: ${started.password}`);
  console.log(`expires: ${started.expiresAt}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Sign in to X over that screen (you type everything yourself), then press Enter here… ");
  rl.close();
  const done = await finishLogin(async (handle) => {
    const { result, url, title } = await probeX(handle);
    return { result, message: `${title} (${url})` };
  });
  if ("error" in done) {
    console.error(done.error);
    process.exit(1);
  }
  console.log(`${done.result}: ${done.message}`);
  if (done.result !== "ok") process.exitCode = 1;
}

async function probeCmd(): Promise<void> {
  const handle = await start(xStartOpts());
  try {
    const { result, url, title } = await probeX(handle);
    console.log(`${result}: ${title} (${url})`);
    if (result !== "ok") process.exitCode = 1;
  } finally {
    await handle.stop();
  }
}

async function main(): Promise<void> {
  switch (sub) {
    case "post": {
      const matchId = Number(subArgs[0]);
      if (!Number.isSafeInteger(matchId) || matchId <= 0) {
        console.error(usage);
        process.exit(2);
      }
      if (viaBrowser()) {
        const { plan, done } = await postMatchViaBrowser(matchId, { dryRun });
        console.log(describeOutcome(done));
        console.log(plan.text);
        if (done.outcome !== "posted" && done.outcome !== "dry-run") process.exitCode = 1;
        return;
      }
      const { plan, record } = await postMatch(matchId, { dryRun });
      console.log(
        record ? `posted: https://x.com/i/status/${record.postId}` : `would post ${plan.clipPath}:`,
      );
      console.log(plan.text);
      return;
    }
    case "auto": {
      if (viaBrowser()) {
        console.log(await xBrowserTick({ dryRun }));
        return;
      }
      if (!isXConfigured()) {
        console.log(NOT_CONFIGURED);
        return;
      }
      console.log(await autoPost({ dryRun }));
      return;
    }
    case "status": {
      const missing = X_KEY_NAMES.filter((k) => !process.env[k]?.trim());
      console.log(isXConfigured() ? "keys: all four set" : `keys: missing ${missing.join(", ")}`);
      console.log(`xAutoPost: ${config.xAutoPost ? "on" : "off"}`);
      console.log(`xBrowserPost: ${config.xBrowserPost ? "on" : "off"}`);
      console.log(
        `profile: ${X_PROFILE_DIR} ${existsSync(X_PROFILE_DIR) ? "(exists)" : "(none yet: npm run x -- login)"}`,
      );
      const state = readXBrowserState();
      console.log(
        state
          ? `browser: last probe ${state.lastProbe ?? "none"} at ${state.lastProbeAt ?? "-"}, last post ${state.lastPostAt ?? "none"}${state.lastError ? `, last error: ${state.lastError}` : ""}`
          : "browser: never run",
      );
      const last = await lastXPost();
      console.log(
        last
          ? `last post: match ${last.matchId} at ${last.at} ${last.postId.startsWith("browser:") ? last.postId : `https://x.com/i/status/${last.postId}`}`
          : "last post: none",
      );
      const next = await pickXCandidate();
      console.log(next ? `next: match ${next.matchId}\n${next.text}` : "next: nothing to post");
      return;
    }
    case "login":
      await loginCmd();
      return;
    case "probe":
      await probeCmd();
      return;
    default:
      console.error(usage);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof XRefusal ? err.message : describeError(err));
  process.exit(1);
});
