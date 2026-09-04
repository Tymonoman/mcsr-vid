/**
 * One-shot Google consent, run by hand: `npm run youtube-auth`.
 *
 * Uses the loopback redirect rather than the device flow, because the device flow only supports
 * `youtube` and `youtube.readonly` — it cannot grant `youtube.upload`, `youtube.force-ssl` or
 * `yt-analytics.readonly`, which is most of what the dashboard needs. Loopback means this has to
 * run on a machine with a browser: do it on the laptop, then copy `youtube-token.json` to the
 * homelab repo, which is bind-mounted into the container.
 *
 * PKCE is included because Google recommends it for installed apps and it costs one hash. The
 * existing read-only token (the `claude-youtube` skill's) is never touched — this writes a
 * separate file, so that skill keeps working if this consent is ever revoked.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { REQUIRED_SCOPES, tokenPath, type StoredToken } from "./youtube.js";

const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

interface ClientSecrets {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

function secretsPath(): string {
  return (
    process.env.YOUTUBE_CLIENT_SECRETS ??
    // Where the claude-youtube skill already keeps them; reusing that client avoids creating a
    // second OAuth app just to add scopes to the same channel.
    path.join(homedir(), ".claude", "youtube_client_secrets.json")
  );
}

const base64url = (b: Buffer): string => b.toString("base64url");

async function main(): Promise<void> {
  const file = secretsPath();
  if (!existsSync(file)) {
    throw new Error(
      `No OAuth client secrets at ${file}.\n` +
        "Download the JSON for a Desktop-app ('installed') OAuth client from Google Cloud Console,\n" +
        "or point YOUTUBE_CLIENT_SECRETS at it.",
    );
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as ClientSecrets;
  const client = parsed.installed ?? parsed.web;
  if (!client) throw new Error(`${file} has neither an "installed" nor a "web" client.`);
  if (!parsed.installed) {
    console.error("Warning: this is a 'web' client. Loopback redirects need a Desktop-app client.");
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  // Port 0 lets the OS pick. Google accepts any port on a loopback redirect for installed
  // clients, so nothing has to be pre-registered.
  const { code, redirectUri } = await catchAuthCode(state, (uri) => {
    const url = new URL(AUTH_URI);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: uri,
      response_type: "code",
      scope: REQUIRED_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      // Both are required to be *given* a refresh token: offline asks for one, and consent
      // forces a fresh grant rather than silently reusing the existing read-only approval.
      access_type: "offline",
      prompt: "consent",
    }).toString();

    console.error("\nOpen this URL and approve access:\n");
    console.error(url.toString());
    console.error("\nWaiting for the redirect...");
  });

  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${await res.text()}`);

  const body = (await res.json()) as { refresh_token?: string; scope?: string };
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. That happens when the app was already authorised;\n" +
        "revoke it at https://myaccount.google.com/permissions and run this again.",
    );
  }

  const granted = (body.scope ?? "").split(" ").filter(Boolean);
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));

  const token: StoredToken = {
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: body.refresh_token,
    token_uri: TOKEN_URI,
    scopes: granted,
    obtained_at: new Date().toISOString(),
  };
  await writeFile(tokenPath(), JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });

  console.error(`\nWrote ${tokenPath()} (mode 600 — it holds a long-lived refresh token).`);
  if (missing.length > 0) {
    // Not fatal: partial scopes still upload, they just cannot do everything the dashboard offers.
    console.error(`\nWarning: these scopes were NOT granted:\n  ${missing.join("\n  ")}`);
    console.error("Features needing them will fail with a 401 until you re-run this.");
  } else {
    console.error("All required scopes granted.");
  }
  console.error("\nNext: copy this file to the homelab repo so the dashboard container sees it.");
}

/** Serves exactly one request on 127.0.0.1, then shuts down. */
function catchAuthCode(
  expectedState: string,
  announce: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      // A mismatched state means the response is not the one we asked for; refusing it is the
      // whole point of sending state in the first place.
      const stateOk = url.searchParams.get("state") === expectedState;

      const message = error
        ? `Authorisation failed: ${error}`
        : !stateOk
          ? "State mismatch — ignoring this response."
          : code
            ? "Authorised. You can close this tab and go back to the terminal."
            : "No authorisation code in the request.";

      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`${message}\n`);

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close();

      if (error) reject(new Error(`Google returned an error: ${error}`));
      else if (!stateOk) reject(new Error("OAuth state mismatch"));
      else if (!code) reject(new Error("No authorisation code in the redirect"));
      else resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      announce(`http://127.0.0.1:${port}`);
    });
  });
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
