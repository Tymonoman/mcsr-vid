/**
 * The same one X post a day as `xPost.ts`, through a real signed-in browser instead of the paid
 * API (the operator, 22 Oct 2026: "build the x integration through a browser"). What is posted
 * and every refusal stay `planXPost`'s; this file only drives x.com's composer the way the Studio
 * automation drives Studio: the same headed Chrome over CDP (`studioBrowser.start`, so its
 * one-session lock and `killOnExit` apply), its own profile (`X_PROFILE_DIR`, signed in once by
 * hand over `npm run x -- login`), human pacing, a screenshot of every step into the match dir.
 *
 * Never types a password, answers a verification prompt or solves a CAPTCHA: a `signed-out` or
 * `verify` probe is the attempt's outcome, reported for the operator and never retried. A failed
 * post is never retried either; `x.json` (written only once the post went out) is "posted".
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import {
  page as pageOf,
  start,
  type StudioBrowserOptions,
  type StudioHandle,
} from "../youtube/studioBrowser.js";
import { updateXBrowserState, type XProbeResult } from "./xBrowserState.js";
import {
  pickXCandidate,
  planXPost,
  postedToday,
  writeXRecord,
  xFile,
  XRefusal,
  type XPlan,
  type XRecord,
} from "./xPost.js";

/** The X account's own Chrome profile; never the Studio one (a different Google-free login). */
export const X_PROFILE_DIR = process.env.X_PROFILE_DIR || "/app/.x-profile";
export const X_HOME = "https://x.com/home";
export const X_LOGIN = "https://x.com/login";

/** Selectors as x.com served them on 22 Oct 2026; the fixture in `xBrowser.test.ts` mirrors them. */
const SEL = {
  composer: '[data-testid="tweetTextarea_0"]',
  accountMenu: '[data-testid="SideNav_AccountSwitcher_Button"]',
  loginForm: 'input[autocomplete="username"], [data-testid="loginButton"]',
  fileInput: 'input[data-testid="fileInput"], input[type="file"]',
  attachments: '[data-testid="attachments"]',
  postButton: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]',
  toast: '[data-testid="toast"]',
  article: 'article[data-testid="tweet"]',
};

/** 2–6 s, the Studio actions' own pace; tests pass a faster one. */
export const randomPause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 4000));

export interface XBrowserOptions {
  dryRun?: boolean;
  /** The timeline URL; a test points it at a local fixture. */
  home?: string;
  pace?: () => Promise<void>;
  /** How long X may take to process the attached video before the attempt fails. */
  mediaTimeoutMs?: number;
}

export type XBrowserOutcome =
  | { outcome: "posted"; record: XRecord; url: string | null }
  | { outcome: "dry-run"; screenshot: string }
  | { outcome: "signed-out" | "verify" | "error"; message: string };

/** Creates the profile dir, private to this user, and returns it. */
export function ensureXProfileDir(dir: string = X_PROFILE_DIR): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** `start()` options for an X session: the caller's chromePath/port/display, never its profile
 * (the worker's `--profile-dir` is Studio's); the X profile, created 700 if missing. */
export function xStartOpts(opts: StudioBrowserOptions = {}, profileDir: string = X_PROFILE_DIR): StudioBrowserOptions {
  return { ...opts, profileDir: ensureXProfileDir(profileDir) };
}

/**
 * Pure classification of a loaded page, unit-testable without a browser. A visible composer or
 * account menu is `ok` whatever the page text says (a timeline quotes anything, "verify" included);
 * then a challenge/verification/CAPTCHA page; then X's own login flow; anything else is `error`,
 * since "ok" must be positively confirmed before the composer is touched.
 */
export function classifyX(
  url: string,
  text: string,
  dom: { composer: boolean; loginForm: boolean },
): XProbeResult {
  if (dom.composer) return "ok";
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a URL (a test's bare path): classify the string as is.
  }
  if (
    /\/account\/access|\/i\/flow\/(?!login$)/.test(pathname) ||
    /verify your|confirm your (?:email|phone)|enter your phone|not a robot|captcha|suspicious|unusual (?:login|activity)/i.test(
      text,
    )
  )
    return "verify";
  if (dom.loginForm || /\/i\/flow\/login|^\/login|\/logout/.test(pathname)) return "signed-out";
  return "error";
}

async function readDom(p: Page): Promise<{ composer: boolean; loginForm: boolean }> {
  const visible = (sel: string) =>
    p
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false);
  return {
    composer: (await visible(SEL.composer)) || (await visible(SEL.accountMenu)),
    loginForm: await visible(SEL.loginForm),
  };
}

/** Loads the timeline and classifies the session; records the answer in `.x-browser.json`. */
export async function probeX(
  handle: StudioHandle,
  opts: Pick<XBrowserOptions, "home"> = {},
): Promise<{ result: XProbeResult; url: string; title: string }> {
  const p = await pageOf(handle);
  await p.goto(opts.home ?? X_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // A login redirect or a challenge interstitial settles a few seconds after the first paint.
  await p.waitForTimeout(opts.home ? 500 : 5000);
  const url = p.url();
  const title = await p.title().catch(() => "");
  const text = await p
    .locator("body")
    .innerText()
    .catch(() => "");
  const result = classifyX(url, text, await readDom(p));
  updateXBrowserState({ lastProbe: result, lastProbeAt: new Date().toISOString() });
  return { result, url, title };
}

/** Types like a person: a few words at a time, a keystroke delay, a short breath between chunks. */
async function typeChunked(p: Page, text: string): Promise<void> {
  const chunks = text.match(/[^\s]+\s*|\s+/g) ?? [text];
  for (let i = 0; i < chunks.length; i += 3) {
    await p.keyboard.type(chunks.slice(i, i + 3).join(""), { delay: 40 + Math.random() * 60 });
    await p.waitForTimeout(150 + Math.random() * 350);
  }
}

async function shotX(p: Page, matchId: number, label: string): Promise<string> {
  const file = path.join(
    matchDir(matchId),
    `x-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  );
  await p.screenshot({ path: file }).catch(() => {
    // The action's own result says what happened; a lost screenshot must not fail it.
  });
  return file;
}

/** Polls `check` until true or `ms` pass; false on timeout. */
async function until(check: () => Promise<boolean>, ms: number, step = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/**
 * Drives the composer on an already-`ok` session: text, the clip, a screenshot, then (not dry)
 * the Post button, the sent toast/timeline article, `x.json`. Throws on anything the page does
 * not do within its wait; the caller records the error. Nothing here retries.
 */
export async function postViaBrowser(
  handle: StudioHandle,
  plan: XPlan,
  opts: XBrowserOptions = {},
): Promise<XBrowserOutcome> {
  if (existsSync(xFile(plan.matchId))) throw new XRefusal(`match ${plan.matchId} is already on X (x.json)`);
  const pace = opts.pace ?? randomPause;
  const p = await pageOf(handle);
  const home = opts.home ?? X_HOME;
  if (p.url() !== home) await p.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await pace();

  const composer = p.locator(SEL.composer).first();
  await composer.click({ timeout: 15_000 });
  await pace();
  await typeChunked(p, plan.text);
  await pace();

  await p.locator(SEL.fileInput).first().setInputFiles(plan.clipPath, { timeout: 15_000 });
  await p.locator(SEL.attachments).first().waitFor({ state: "visible", timeout: 30_000 });
  const button = p.locator(SEL.postButton).first();
  // X shows a progress bar on the attachment while it uploads/processes and keeps the button
  // disabled; the post goes only once both have cleared.
  const processed = await until(
    async () =>
      (await p.locator(`${SEL.attachments} [role="progressbar"]`).count()) === 0 &&
      (await button.isEnabled()),
    opts.mediaTimeoutMs ?? 180_000,
  );
  if (!processed) throw new Error("X did not finish processing the video in time");
  await pace();
  const composeShot = await shotX(p, plan.matchId, "compose");
  if (opts.dryRun) return { outcome: "dry-run", screenshot: composeShot };

  await button.click({ timeout: 15_000 });
  const sent = await until(
    async () =>
      (await p.locator(`${SEL.toast}:has-text("sent")`).count()) > 0 ||
      ((await composer.innerText().catch(() => plan.text)).trim() === "" &&
        (await p.locator(SEL.attachments).count()) === 0),
    30_000,
  );
  if (!sent) throw new Error('no "Your post was sent" after clicking Post');

  const firstLine = plan.text.split("\n")[0]!;
  let url: string | null = null;
  await until(async () => {
    const href = await p
      .locator(`${SEL.article}:has-text(${JSON.stringify(firstLine)}) a[href*="/status/"]`)
      .first()
      .getAttribute("href", { timeout: 1000 });
    if (href) url = new URL(href, home).toString();
    return url !== null;
  }, 20_000);
  const id = url ? /\/status\/(\d+)/.exec(url)?.[1] : undefined;
  const record: XRecord = {
    postId: id ?? `browser:${Date.now()}`,
    at: new Date().toISOString(),
    text: plan.text,
    mediaId: "",
    via: "browser",
  };
  await writeXRecord(plan.matchId, record);
  await shotX(p, plan.matchId, "posted");
  return { outcome: "posted", record, url };
}

/**
 * One plan, its own browser session: start Chrome on the X profile, probe, post, stop. A
 * `signed-out`/`verify` probe or a thrown error is returned as the outcome and written to
 * `.x-browser.json`; the caller decides what to print. `startOpts` is the test's seam.
 */
export async function postPlanViaBrowser(
  plan: XPlan,
  opts: XBrowserOptions & { startOpts?: StudioBrowserOptions } = {},
): Promise<XBrowserOutcome> {
  if (existsSync(xFile(plan.matchId))) throw new XRefusal(`match ${plan.matchId} is already on X (x.json)`);
  const handle = await start(xStartOpts(opts.startOpts));
  try {
    const probed = await probeX(handle, opts);
    if (probed.result !== "ok") {
      return { outcome: probed.result, message: `${probed.title} (${probed.url})` };
    }
    const done = await postViaBrowser(handle, plan, opts);
    if (done.outcome === "posted")
      updateXBrowserState({ lastPostAt: done.record.at, lastMatchId: plan.matchId, lastError: null });
    return done;
  } catch (err) {
    if (err instanceof XRefusal) throw err;
    const message = describeError(err);
    updateXBrowserState({ lastError: message, lastMatchId: plan.matchId });
    return { outcome: "error", message };
  } finally {
    await handle.stop();
  }
}

/** `npm run x -- post <id> --via browser`: `planXPost`'s refusals (thrown as `XRefusal`), then the above. */
export async function postMatchViaBrowser(
  matchId: number,
  opts: XBrowserOptions & { startOpts?: StudioBrowserOptions } = {},
): Promise<{ plan: XPlan; done: XBrowserOutcome }> {
  const plan = await planXPost(matchId);
  if (typeof plan === "string") throw new XRefusal(plan);
  return { plan, done: await postPlanViaBrowser(plan, opts) };
}

export function describeOutcome(done: XBrowserOutcome): string {
  switch (done.outcome) {
    case "posted":
      return `posted: ${done.url ?? `(id unread: ${done.record.postId})`}`;
    case "dry-run":
      return `dry run: stopped before Post, see ${done.screenshot}`;
    case "signed-out":
      return "X: signed out, sign in with npm run x -- login";
    case "verify":
      return `X: verification prompt, clear it over npm run x -- login: ${done.message}`;
    case "error":
      return `X post failed: ${done.message}`;
  }
}

/**
 * The worker's (and `npm run x -- auto --via browser`'s) step: at most one post a UTC day
 * (`postedToday`, shared with the API poster), the newest candidate `pickXCandidate` lets through,
 * posted through the browser. Returns one line for the log. Dry: the whole drive minus the click.
 */
export async function xBrowserTick(
  opts: XBrowserOptions & { startOpts?: StudioBrowserOptions; now?: number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const last = await postedToday(now);
  if (last) return `already posted today (match ${last.matchId})`;
  const plan = await pickXCandidate(now);
  if (!plan) return "nothing to post";
  const done = await postPlanViaBrowser(plan, opts);
  return `match ${plan.matchId}: ${describeOutcome(done)}`;
}

