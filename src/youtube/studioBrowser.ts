/**
 * A real Chrome, headed, on a virtual screen, with a login profile saved on disk — the one thing
 * in this codebase that opens a Google page.
 *
 * `connectOverCDP`, never `chromium.launch()`: a browser Playwright launches carries its own
 * automation markers (`--enable-automation`, the automation-controlled bit CDP's own
 * `Runtime.enable` trips), which is exactly what a browser signed into the owner's Google account
 * must not show. This starts Xvfb and Chrome itself — plain flags, no `--headless`, no
 * `--enable-automation` — and only then connects to the debugging port Chrome opened on its own;
 * Chrome never knows Playwright is there. See handbook/knowledge/studio-automation-plan-2026-09-28.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { config, matchDir } from "../config.js";

/** The profile Chrome's cookies and login live in — a named volume mounted here (compose.yaml) once the
 * image carries Chrome; `STUDIO_PROFILE_DIR` points elsewhere. Until that rebuild, the operator's login
 * (7 Oct 2026) lives in `/app/.studio-profile` (gitignored, 700) and the jobs run from the Claude
 * container, which has Chrome, with `STUDIO_PROFILE_DIR=/app/.studio-profile`. */
export const DEFAULT_PROFILE_DIR = process.env.STUDIO_PROFILE_DIR || "/home/node/.studio-profile";
/** `google-chrome-stable`'s install path on the Debian package; resolved via PATH. */
export const DEFAULT_CHROME_PATH = "google-chrome-stable";

export interface StudioBrowserOptions {
  profileDir?: string;
  chromePath?: string;
  debugPort?: number;
  /** The X display Chrome renders on, e.g. ":99". */
  display?: string;
  /** Appended after the fixed flags below (which already carry `--no-sandbox`). */
  extraArgs?: string[];
}

export interface StudioHandle {
  browser: Browser;
  debugPort: number;
  /** SIGTERM (cookies flush), wait, SIGKILL after a grace, then stop Xvfb. Always safe to call twice. */
  stop(): Promise<void>;
}

let active: StudioHandle | null = null;
/** Claimed synchronously as `start`'s first statement, before any `await` — `active` itself is
 * only set once Chrome has actually connected, several awaits later (Xvfb's sleep, the CDP poll),
 * so two `start()` calls issued back to back would otherwise both read `active` as null and both
 * pass the guard, each spawning its own Xvfb/Chrome against the same profile. Cleared in `start`'s
 * catch so a failed start does not wedge the lock open forever. */
let starting = false;

/** One browser at a time, in this process — the in-process half of the lock (the other half is
 * the profile's own `SingletonLock`, checked in `start`). True for the whole span from the first
 * line of `start()` to `stop()`, not just once Chrome has connected. */
export const isRunning = (): boolean => active !== null || starting;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The pid of a Chrome already holding this profile, read from its `SingletonLock` symlink
 * (`<hostname>-<pid>`), or null when there is none or it is stale (the process is gone). A lock
 * this reads as live is a lock this refuses to also open: two Chromes sharing one profile corrupt it.
 */
function liveLockPid(profileDir: string): number | null {
  let target: string;
  try {
    target = readlinkSync(path.join(profileDir, "SingletonLock"));
  } catch {
    return null;
  }
  const m = /-(\d+)$/.exec(target);
  if (!m) return null;
  const pid = Number(m[1]);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** `work`, or a rejection once `ms` have passed. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer after ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Polls Chrome's own debugging endpoint until it answers — the one `fetch` outside the youtube/
 * API surface, because this is a localhost healthcheck, not a web request. */
async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not listening yet — Chrome takes a moment after spawn.
    }
    if (Date.now() > deadline) throw new Error(`Chrome's debugging port ${port} never answered`);
    await sleep(200);
  }
}

/** SIGTERM, wait up to `graceMs` for the process to actually exit, SIGKILL after that. */
async function terminate(proc: ChildProcess, graceMs = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([once(proc, "exit").catch(() => {}), sleep(graceMs)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

/**
 * Kills Chrome and Xvfb if this process exits while they still run. An uncaught throw (a
 * Playwright-internal "Assertion error" in CRSession._onMessage, 14 Oct 2026) or an unhandled
 * rejection skips every `stop()`, and the orphaned Chrome kept the profile's SingletonLock: every
 * later `start()` refused "already running" until it was killed by hand. Only this process's own
 * two children, through their handles (a reaped child is never signalled). Returns the disarm
 * `stop()` calls, so a long-lived worker never piles up listeners. A SIGKILL of this process
 * itself still orphans them.
 */
export function killOnExit(chrome: ChildProcess, xvfb: ChildProcess): () => void {
  const kill = (): void => {
    for (const [proc, signal] of [
      [chrome, "SIGKILL"],
      [xvfb, "SIGTERM"],
    ] as const) {
      try {
        proc.kill(signal);
      } catch {
        // Best effort: this process is exiting either way, and the other child still needs its signal.
      }
    }
  };
  process.once("exit", kill);
  return () => process.off("exit", kill);
}

/**
 * Starts Xvfb, then Chrome on it with the saved profile, then connects over CDP. Throws (and
 * cleans up what it started) rather than returning a handle that is not actually usable.
 */
export async function start(opts: StudioBrowserOptions = {}): Promise<StudioHandle> {
  if (isRunning()) throw new Error("a Studio browser is already running in this process");
  starting = true;
  try {
    const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
    const chromePath = opts.chromePath ?? DEFAULT_CHROME_PATH;
    const debugPort = opts.debugPort ?? 9222;
    const display = opts.display ?? ":99";

    const livePid = liveLockPid(profileDir);
    if (livePid !== null)
      throw new Error(`Chrome is already running against ${profileDir} (pid ${livePid}) — close it first`);

    mkdirSync(profileDir, { recursive: true });

    const xvfb = spawn("Xvfb", [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    // Xvfb needs no handshake; this is comfortably enough for its socket to exist before Chrome
    // tries to open the display.
    await sleep(300);

    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--lang=en-US",
        // The operator, 7 Oct 2026: "The Chrome launcher must pass --no-sandbox, --disable-sync,
        // --disable-extensions and use the profile I logged into." He signed in to Chrome itself
        // (sync on, his own extensions): sync and extensions stay off for every automated run, and
        // the containers have no usable Chromium sandbox (no unprivileged user namespaces).
        "--no-sandbox",
        "--disable-sync",
        "--disable-extensions",
        // The profile was created with the basic store (no keyring in a container); the cookies
        // only decrypt under the same one.
        "--password-store=basic",
        "--window-size=1440,900",
        ...(opts.extraArgs ?? []),
        "about:blank",
      ],
      { env: { ...process.env, DISPLAY: display }, stdio: "ignore" },
    );
    const disarm = killOnExit(chrome, xvfb);

    // A connect that fails after the port answered must not leave Chrome holding the profile's
    // SingletonLock either — every later start() would refuse with "already running".
    let browser: Browser;
    try {
      await waitForCdp(debugPort, 20_000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    } catch (err) {
      disarm();
      chrome.kill("SIGKILL");
      xvfb.kill("SIGTERM");
      throw err;
    }

    const handle: StudioHandle = {
      browser,
      debugPort,
      async stop() {
        if (active !== handle) return;
        active = null;
        // `browser.close()` on a `connectOverCDP` connection disconnects Playwright without
        // killing Chrome — the SIGTERM below is what actually flushes cookies and exits it.
        await browser.close().catch(() => {});
        await terminate(chrome);
        xvfb.kill("SIGTERM");
        disarm();
      },
    };
    active = handle;
    return handle;
  } finally {
    starting = false;
  }
}

/** The handle's first page, or a fresh one — Chrome was launched on `about:blank`, so there is
 * always at least one context and page to reuse rather than opening a second tab every call. */
export async function page(handle: StudioHandle): Promise<Page> {
  const [context] = handle.browser.contexts();
  const ctx = context ?? (await handle.browser.newContext());
  const [existing] = ctx.pages();
  return existing ?? (await ctx.newPage());
}

export type ProbeResult = "ok" | "signed-out" | "verify" | "wrong-channel";

/**
 * Pure classification of a loaded page — no browser, so this is unit-testable on its own.
 * Checked in order: signed-out (redirected to Google's own sign-in), verify (a challenge or
 * CAPTCHA page), then whether the URL names our channel id, another channel's, or neither (the
 * page text is the last resort for "ok" — `wrong-channel` is also what an unreadable answer
 * becomes, since "ok" must be positively confirmed before any Studio action trusts it).
 */
export function classify(url: string, title: string, text: string, channelId: string): ProbeResult {
  // Checked before the broader "signed-out" test below: Google's own challenge/2FA pages also
  // live on accounts.google.com, so a URL match there would otherwise always shadow this one.
  if (/\/challenge\//.test(url) || /verify it.?s you/i.test(text) || /unusual traffic|recaptcha/i.test(text))
    return "verify";
  if (/accounts\.google\.com/.test(url) || /\/ServiceLogin/i.test(url)) return "signed-out";
  const onChannel = new RegExp(`/channel/${channelId}(?:[/?]|$)`).exec(url);
  if (onChannel) return "ok";
  if (/\/channel\/[A-Za-z0-9_-]{5,}/.exec(url)) return "wrong-channel";
  return text.includes(channelId) ? "ok" : "wrong-channel";
}

const lastProbePath = (): string => path.join(config.mediaDir, ".studio-probe.json");

export interface LastProbe {
  result: ProbeResult;
  message: string;
  at: string;
}

function writeLastProbe(result: ProbeResult, message: string): void {
  try {
    mkdirSync(config.mediaDir, { recursive: true });
    const tmp = `${lastProbePath()}.tmp`;
    const probe: LastProbe = { result, message, at: new Date().toISOString() };
    writeFileSync(tmp, JSON.stringify(probe, null, 2));
    renameSync(tmp, lastProbePath());
  } catch {
    // Best effort: the nightly strip missing one probe is not worth crashing a probe over.
  }
}

/** The last probe any Studio job made, for the nightly strip and `GET /api/studio/status` — or
 * null before the first one. */
export function readLastProbe(): LastProbe | null {
  if (!existsSync(lastProbePath())) return null;
  try {
    return JSON.parse(readFileSync(lastProbePath(), "utf8")) as LastProbe;
  } catch {
    return null;
  }
}

/**
 * Loads Studio and classifies the session. Runs at the start of every Studio job and records the
 * answer (`writeLastProbe`), which is the one thing the nightly strip's red line reads.
 */
export async function probe(
  handle: StudioHandle,
  channelId: string = config.youtubeChannelId,
): Promise<{ result: ProbeResult; url: string; title: string }> {
  const p = await page(handle);
  await withTimeout(
    // The channel's own Studio URL, never the root: the root opens the signed-in account's default
    // channel (the operator's personal one, 7 Oct 2026), while this one switches to the brand channel
    // he manages — and redirects to the default one only when the account has no access to it.
    p.goto(`https://studio.youtube.com/channel/${channelId}?hl=en`, { waitUntil: "domcontentloaded" }),
    30_000,
    "loading Studio",
  );
  // A sign-in, challenge or no-access redirect settles a few seconds after the initial load.
  await p.waitForTimeout(5000);
  const url = p.url();
  const title = await p.title().catch(() => "");
  const text = await p
    .locator("body")
    .innerText()
    .catch(() => "");
  const result = classify(url, title, text, channelId);
  writeLastProbe(result, `${title} (${url})`);
  return { result, url, title };
}

/**
 * Starts Chrome and probes Studio; stops Chrome and returns null on anything but `ok` (a failed
 * probe is already recorded on disk by `probe()` itself, `readLastProbe()`) — the one "stop,
 * don't guess" gate every single-video CLI command shares (`studioCli.ts`'s `pin`/`endscreen`/
 * `tc`/`tc-read`). `deps` is for testing without a real browser.
 *
 * Regression fixed 8 Oct 2026: this used to be a `studioCli.ts`-local helper that called `start()`
 * then `probe(handle)` with no try/catch of its own, trusting that every caller's own
 * `try { ... } finally { await handle.stop(); }` around the *returned* handle would cover it —
 * but that finally only ever runs once this function has already returned a handle. A `goto`
 * timeout or a crashed renderer inside `probe()` threw straight out of this function instead,
 * before any handle reached a caller's try/finally, leaking Chrome+Xvfb and holding the
 * profile's `SingletonLock` until something killed it by hand — wedging every later Studio job,
 * including the unattended worker's own `start()` calls, on "Chrome is already running against
 * <profile>". Catching the throw here and stopping before rethrowing is the fix.
 */
export async function startAndProbe(
  opts: StudioBrowserOptions = {},
  deps: { start: typeof start; probe: typeof probe } = { start, probe },
): Promise<StudioHandle | null> {
  const handle = await deps.start(opts);
  let probed: Awaited<ReturnType<typeof probe>>;
  try {
    probed = await deps.probe(handle);
  } catch (err) {
    await handle.stop();
    throw err;
  }
  if (probed.result !== "ok") {
    await handle.stop();
    return null;
  }
  return handle;
}

/** `studio-<label>-<UTC timestamp>.png` into the match directory — the record of what a Studio
 * action actually saw. */
export async function shot(handle: StudioHandle, matchId: number, label: string): Promise<string> {
  const p = await page(handle);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(matchDir(matchId), `studio-${label}-${ts}.png`);
  await p.screenshot({ path: file }).catch(() => {
    // A screenshot failing (a closed page, a crashed renderer) must not fail the action it is
    // documenting — the action's own result already says what happened.
  });
  return file;
}
