/**
 * npm run x -- post <matchId> [--dry-run] | auto [--dry-run] | status
 *
 * post: the one match's hand-cut Short to X (src/x/xPost.ts), or the reason it is refused.
 *      `--dry-run` prints the post and signs nothing, so it works before the keys exist.
 * auto: what the dashboard's tick does when `xAutoPost` is on — the newest public long-form not
 *      yet posted, at most one post a UTC day. Without the four keys it prints "not configured"
 *      and exits 0, dry run or not.
 * status: whether the keys are there (names only, never values), `xAutoPost`, the last post and
 *      the next candidate.
 */
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import { isXConfigured, X_KEY_NAMES } from "./xApi.js";
import { autoPost, lastXPost, pickXCandidate, postMatch, XRefusal } from "./xPost.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [sub, ...subArgs] = args.filter((a) => a !== "--dry-run");
const usage = "usage: npm run x -- post <matchId> [--dry-run] | auto [--dry-run] | status";
const NOT_CONFIGURED = `X is not configured: set ${X_KEY_NAMES.join(", ")} in /app/.env (handbook/x-setup.md)`;

async function main(): Promise<void> {
  switch (sub) {
    case "post": {
      const matchId = Number(subArgs[0]);
      if (!Number.isSafeInteger(matchId) || matchId <= 0) {
        console.error(usage);
        process.exit(2);
      }
      const { plan, record } = await postMatch(matchId, { dryRun });
      console.log(
        record ? `posted: https://x.com/i/status/${record.postId}` : `would post ${plan.clipPath}:`,
      );
      console.log(plan.text);
      return;
    }
    case "auto": {
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
      const last = await lastXPost();
      console.log(
        last
          ? `last post: match ${last.matchId} at ${last.at} https://x.com/i/status/${last.postId}`
          : "last post: none",
      );
      const next = await pickXCandidate();
      console.log(next ? `next: match ${next.matchId}\n${next.text}` : "next: nothing to post");
      return;
    }
    default:
      console.error(usage);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof XRefusal ? err.message : describeError(err));
  process.exit(1);
});
