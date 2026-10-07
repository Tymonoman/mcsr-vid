/**
 * The one-time Studio login screen: Chrome on a virtual display, a remote screen over VNC-over-
 * websockets, and the probe that tells the operator (and the nightly strip) whether it worked.
 *
 * Never types a password or answers 2FA — the operator does that by eye, over the remote screen.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { describeError } from "../errorText.js";
import { config } from "../config.js";
import { anyExportRunning } from "./exportRoutes.js";
import {
  isRunning,
  page,
  probe,
  readLastProbe,
  start,
  type ProbeResult,
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

async function teardown(s: LoginScreen): Promise<void> {
  clearTimeout(s.timer);
  s.websockify.kill("SIGTERM");
  s.x11vnc.kill("SIGTERM");
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

/**
 * Starts Xvfb + Chrome on `studio.youtube.com`, then x11vnc and websockify so a browser on the
 * operator's Tailscale IP can drive it. The password is one-time and never logged — it is in this
 * function's return value only, which the route hands straight to the browser.
 */
export async function startLogin(
  hostname: string,
): Promise<{ url: string; password: string; expiresAt: string } | { error: string }> {
  const refusal = loginRefusal({
    screenRunning: screen !== null,
    exportRunning: anyExportRunning(),
    browserLocked: isRunning(),
  });
  if (refusal) return { error: refusal };

  try {
    const handle = await start();
    await (
      await page(handle)
    )
      .goto("https://studio.youtube.com/?hl=en", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => {
        // Worth trying so the remote screen opens on Studio rather than a blank tab; a sign-in
        // redirect or a slow load is exactly what the operator is about to look at by eye.
      });

    const password = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
    const x11vnc = spawn(
      "x11vnc",
      [
        "-display",
        ":99",
        "-localhost",
        "-rfbport",
        "5900",
        "-passwd",
        password,
        "-forever",
        "-shared",
        "off",
      ],
      { stdio: "ignore" },
    );
    await waitForPort(5900, 5000);
    const websockify = spawn("websockify", ["--web", "/usr/share/novnc", "0.0.0.0:6080", "localhost:5900"], {
      stdio: "ignore",
    });

    const expiresAt = Date.now() + SCREEN_LIFETIME_MS;
    const timer = setTimeout(() => void stopLogin(), SCREEN_LIFETIME_MS);
    screen = { handle, x11vnc, websockify, password, expiresAt, timer };
    return {
      url: `http://${hostname}:6080/vnc.html?autoconnect=1`,
      password,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch (err) {
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
} {
  return { screen: screen ? "running" : "stopped", lastProbe: readLastProbe() };
}
