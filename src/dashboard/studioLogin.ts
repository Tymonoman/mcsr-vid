/**
 * The one-time Studio login screen: Chrome on a virtual display, a remote screen over VNC-over-
 * websockets, and the probe that tells the operator (and the nightly strip) whether it worked.
 *
 * Never types a password or answers 2FA — the operator does that by eye, over the remote screen.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describeError } from "../errorText.js";
import { config } from "../config.js";
import { anyExportRunning } from "./exportRoutes.js";
import {
  DEFAULT_PROFILE_DIR,
  isRunning,
  page,
  probe,
  readLastProbe,
  start,
  type ProbeResult,
  type StudioBrowserOptions,
  type StudioHandle,
} from "../youtube/studioBrowser.js";

/** Auto-stop the screen after this long, whether or not anyone pressed Done. */
const SCREEN_LIFETIME_MS = 15 * 60_000;

interface LoginScreen {
  handle: StudioHandle;
  x11vnc: ChildProcess;
  websockify: ChildProcess;
  password: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  profileDir: string;
}

let screen: LoginScreen | null = null;

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing is listening on 127.0.0.1:${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/**
 * Survives a dashboard restart the running processes themselves do not notice (tini reparents
 * them as orphans): the x11vnc/websockify pids and the screen's own deadline, written once both
 * are actually listening and removed by `teardown`. `killOrphanedLoginScreen` is the only reader.
 */
const pidFilePath = (profileDir: string): string => path.join(profileDir, ".studio-login.json");

interface LoginPidFile {
  x11vncPid: number;
  websockifyPid: number;
  expiresAt: number;
}

function writePidFile(profileDir: string, entry: LoginPidFile): void {
  try {
    writeFileSync(pidFilePath(profileDir), JSON.stringify(entry));
  } catch {
    // Best effort: a write failure here costs the boot-time sweep, not this login.
  }
}

/** `/proc/<pid>/cmdline` containing `needle`, so a pid a previous instance wrote is never signalled
 * once its number happens to belong to a different, unrelated process in a fresh container. */
function cmdlineNames(pid: number, needle: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle);
  } catch {
    return false; // No such process (already gone) — nothing to kill.
  }
}

/**
 * Run once at dashboard boot: a login screen a prior instance never got to close (a crash, an
 * OOM kill, `docker restart` with the screen open) leaves x11vnc and websockify running with the
 * one-time password still valid, independent of whatever this process's own `screen`/`active`
 * state says — those reset on every restart, the orphaned processes do not. Best-effort and
 * silent: a missing or unreadable pidfile means there is nothing to clean up.
 *
 * ponytail: a pidfile check, not a process-supervision system — it only ever cleans up what this
 * module itself wrote, verified against `/proc/<pid>/cmdline` so a reused pid is never killed on
 * a guess. Upgrade to a real supervisor (tini subreaper tracking, systemd) if orphans recur for a
 * reason other than "the container restarted with a screen open."
 */
export function killOrphanedLoginScreen(profileDir: string = DEFAULT_PROFILE_DIR): void {
  const file = pidFilePath(profileDir);
  if (!existsSync(file)) return;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as LoginPidFile;
    if (cmdlineNames(entry.x11vncPid, "x11vnc")) process.kill(entry.x11vncPid, "SIGTERM");
    if (cmdlineNames(entry.websockifyPid, "websockify")) process.kill(entry.websockifyPid, "SIGTERM");
  } catch (err) {
    console.error(`studio: boot cleanup of a leftover login screen failed: ${describeError(err)}`);
  } finally {
    rmSync(file, { force: true });
  }
}

async function teardown(s: LoginScreen): Promise<void> {
  clearTimeout(s.timer);
  s.websockify.kill("SIGTERM");
  s.x11vnc.kill("SIGTERM");
  rmSync(pidFilePath(s.profileDir), { force: true });
  await s.handle.stop().catch(() => {});
}

/**
 * Why `startLogin` would refuse, before it touches a single process — a pure function of three
 * booleans, so the precedence (which refusal wins when more than one is true) is unit-testable
 * without a browser, an export job or x11vnc. `null` is "go ahead."
 */
export function loginRefusal(state: {
  screenRunning: boolean;
  exportRunning: boolean;
  browserLocked: boolean;
}): string | null {
  if (state.screenRunning) return "the login screen is already running";
  if (state.exportRunning) return "an export is running on this box — try again once it finishes";
  if (state.browserLocked) return "another Studio job holds the browser — try again once it finishes";
  return null;
}

/** Whether a shared secret is configured — `STUDIO_LOGIN_SECRET` in `/app/.env`, loaded the way
 * every other secret in this codebase is (`process.loadEnvFile`, `src/api/twitch.ts`). Unset (the
 * default) means these three routes carry the same trust model as every other dashboard route:
 * reaching the port is reaching the API. Set, a login/probe needs the same string back — the
 * login screen hands over an interactive, already-authenticated Google session, a larger blast
 * radius than anything else unauthenticated here, so this is the one route worth the extra step
 * on a box reachable from the whole LAN (compose.yaml binds the dashboard on 0.0.0.0). */
export const secretConfigured = (): boolean => !!process.env.STUDIO_LOGIN_SECRET?.trim();

/** Constant-time where it matters (a real secret compare), `false` on any shape mismatch. */
export function studioSecretOk(provided: string | undefined | null): boolean {
  const expected = process.env.STUDIO_LOGIN_SECRET?.trim();
  if (!expected) return true; // No secret configured: open, like every other route.
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Starts Xvfb + Chrome on `studio.youtube.com`, then x11vnc and websockify so a browser on the
 * operator's Tailscale IP can drive it. The password is one-time and never logged — it is in this
 * function's return value only, which the route hands straight to the browser.
 */
export async function startLogin(
  hostname: string,
  opts: StudioBrowserOptions = {},
): Promise<{ url: string; password: string; expiresAt: string } | { error: string }> {
  const refusal = loginRefusal({
    screenRunning: screen !== null,
    exportRunning: anyExportRunning(),
    browserLocked: isRunning(),
  });
  if (refusal) return { error: refusal };

  const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
  let handle: StudioHandle | undefined;
  let x11vnc: ChildProcess | undefined;
  try {
    handle = await start(opts);
    await (
      await page(handle)
    )
      .goto("https://studio.youtube.com/?hl=en", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => {
        // Worth trying so the remote screen opens on Studio rather than a blank tab; a sign-in
        // redirect or a slow load is exactly what the operator is about to look at by eye.
      });

    const password = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
    // The same display `start()` just put Chrome on — not a second hardcoded ":99" that would
    // silently point x11vnc at the wrong display whenever `opts.display` ever overrides it (as a
    // test profile does).
    const display = opts.display ?? ":99";
    // `-nevershared`, not `-shared off`: the installed x11vnc (Debian bookworm's 0.9.16-9, what
    // the Dockerfile's `apt-get install x11vnc` pulls) takes `-shared` as a bare boolean flag —
    // sharing is off by default already — and rejects an argument after it, so `-shared off`
    // never actually binds the port. `-nevershared` is the single flag this version supports for
    // refusing a second viewer outright.
    x11vnc = spawn(
      "x11vnc",
      [
        "-display",
        display,
        "-localhost",
        "-rfbport",
        "5900",
        "-passwd",
        password,
        "-forever",
        "-nevershared",
      ],
      { stdio: "ignore" },
    );
    await waitForPort(5900, 5000);
    const websockify = spawn("websockify", ["--web", "/usr/share/novnc", "0.0.0.0:6080", "localhost:5900"], {
      stdio: "ignore",
    });

    const expiresAt = Date.now() + SCREEN_LIFETIME_MS;
    const timer = setTimeout(() => void stopLogin(), SCREEN_LIFETIME_MS);
    screen = { handle, x11vnc, websockify, password, expiresAt, timer, profileDir };
    writePidFile(profileDir, { x11vncPid: x11vnc.pid!, websockifyPid: websockify.pid!, expiresAt });
    return {
      url: `http://${hostname}:6080/vnc.html?autoconnect=1`,
      password,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch (err) {
    // `start()` (and the goto that follows it) can succeed while the x11vnc/websockify step after
    // it fails — the browser is already up at that point, so leaving it running would leak Chrome
    // + Xvfb and, worse, leave `isRunning()` true for ever: every later Studio job (a retry, a
    // probe, a pin) would then refuse with "already running" until the whole container restarts.
    x11vnc?.kill("SIGTERM");
    await handle?.stop().catch(() => {});
    return { error: describeError(err) };
  }
}

/** Stops the screen without probing — the 15-minute auto-stop, and a refusal's own cleanup. */
export async function stopLogin(): Promise<void> {
  const s = screen;
  if (!s) return;
  screen = null;
  await teardown(s);
}

/** Probes the session, tears the screen down either way, and returns what the probe found. */
export async function finishLogin(): Promise<{ result: ProbeResult; message: string } | { error: string }> {
  const s = screen;
  if (!s) return { error: "no login screen is running" };
  try {
    const { result, url, title } = await probe(s.handle, config.youtubeChannelId);
    return { result, message: `${title} (${url})` };
  } catch (err) {
    return { error: describeError(err) };
  } finally {
    screen = null;
    await teardown(s);
  }
}

export function loginStatus(): {
  screen: "running" | "stopped";
  lastProbe: ReturnType<typeof readLastProbe>;
  secretRequired: boolean;
} {
  return {
    screen: screen ? "running" : "stopped",
    lastProbe: readLastProbe(),
    secretRequired: secretConfigured(),
  };
}
