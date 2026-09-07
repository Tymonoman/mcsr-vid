/**
 * Is the stored YouTube credential going to work when the pipeline needs it?
 *
 * Prints one line to stdout only when something needs attention; silence means fine. Exits 0
 * either way — a preflight reports, it does not fail the session.
 *
 * Two distinct failures, and they need different answers:
 *   - The refresh token is dead. Authoritative, found by using it.
 *   - The refresh token still works but the OAuth consent screen is left in "Testing", where
 *     Google issues refresh tokens that expire after 7 days. That one is invisible until the
 *     day it bites, which is exactly the failure mode this whole script exists for.
 *
 * The 7-day warning stops on its own: a token that is still alive past day 8 proves the app is
 * in production, so a marker is written and the age check never runs again. Without that it
 * would nag forever once the app was published, and a preflight nobody reads is worse than none.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const TESTING_TOKEN_LIFETIME_DAYS = 7;
/** Past this age a live token cannot be on the Testing clock, so the app must be published. */
const PROVEN_PRODUCTION_DAYS = 8;
const WARN_WITHIN_HOURS = 48;

const tokenFile = process.env.YOUTUBE_TOKEN_FILE ?? path.resolve("youtube-token.json");
if (!existsSync(tokenFile)) process.exit(0); // Not set up yet is not a problem to report.

const marker = path.join(path.dirname(tokenFile), ".youtube-production-confirmed");
const warn = (msg) => console.log(`  youtube: ${msg}`);

let token;
try {
  token = JSON.parse(readFileSync(tokenFile, "utf8"));
} catch (err) {
  warn(`${tokenFile} is not readable JSON (${err.message}). Re-run: npm run youtube-auth`);
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
try {
  const res = await fetch(token.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    warn(
      `refresh token REJECTED (HTTP ${res.status}). Uploads and analytics will fail. ` +
        `Re-run 'npm run youtube-auth' on a machine with a browser and copy youtube-token.json over.`,
    );
    process.exit(0);
  }
} catch (err) {
  // A network blip is not a credential problem; say so rather than crying wolf.
  warn(`could not reach Google to check the token (${err.name}). Skipped, not failed.`);
  process.exit(0);
} finally {
  clearTimeout(timer);
}

// The token works. The only remaining question is whether it is on the Testing clock.
if (existsSync(marker) || !token.obtained_at) process.exit(0);

const ageDays = (Date.now() - Date.parse(token.obtained_at)) / 86_400_000;
if (ageDays >= PROVEN_PRODUCTION_DAYS) {
  writeFileSync(marker, `alive at ${ageDays.toFixed(1)} days, so the OAuth app is in production\n`);
  process.exit(0);
}

const hoursLeft = (TESTING_TOKEN_LIFETIME_DAYS - ageDays) * 24;
if (hoursLeft <= WARN_WITHIN_HOURS) {
  warn(
    `token works, but is ${ageDays.toFixed(1)} days old. If the OAuth consent screen is still ` +
      `"Testing", Google kills it in ~${Math.max(0, hoursLeft).toFixed(0)}h. ` +
      `Publish the app, then re-run 'npm run youtube-auth'.`,
  );
}
