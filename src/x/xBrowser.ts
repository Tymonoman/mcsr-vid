/**
 * The same one X post a day as `xPost.ts`, through a real signed-in browser instead of the paid
 * API (the operator, 22 Oct 2026: "build the x integration through a browser"). What is posted
 * and every refusal stay `planXPost`'s; this file only drives x.com's composer the way the Studio
 * automation drives Studio: the same headed Chrome over CDP (`studioBrowser.start`, so its
 * one-session lock and `killOnExit` apply), its own profile (`X_PROFILE_DIR`, signed in once by
 * hand over `npm run x -- login`), human pacing, a screenshot of every step into the match dir.
 *
 * Never types a password, answers a verification prompt or solves a CAPTCHA: a `signed-out`,
 * `verify` or `wrong-account` probe is the attempt's outcome, reported for the operator and never
 * retried. A failed attempt waits for the next UTC day. `x.json` is written (`browser:pending`)
 * just before the Post click, so a click X never confirms still counts as posted: never twice.
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import {
  page as pageOf,
  start,
  type StudioBrowserOptions,
  type StudioHandle,
} from "../youtube/studioBrowser.js";
import { isXConfigured } from "./xApi.js";
import { readXBrowserState, updateXBrowserState, type XProbeResult } from "./xBrowserState.js";
import {
  pickXCandidate,
  planXPost,
  writeXRecord,
  xFile,
  XRefusal,
  xTooSoon,
  type XPlan,
  type XRecord,
} from "./xPost.js";

/** The X account's own Chrome profile; never the Studio one (a different Google-free login). */
export const X_PROFILE_DIR = process.env.X_PROFILE_DIR || "/app/.x-profile";
export const X_HOME = "https://x.com/home";
export const X_LOGIN = "https://x.com/login";
/** `x.json`'s `postId` from just before the Post click until X confirms the post. */
export const PENDING_POST_ID = "browser:pending";

/** Selectors as x.com served them on 22 Oct 2026; the fixture in `xBrowser.test.ts` mirrors them. */
const SEL = {
  composer: '[data-testid="tweetTextarea_0"]',
  accountMenu: '[data-testid="SideNav_AccountSwitcher_Button"]',
  avatar: '[data-testid^="UserAvatar-Container-"]',
  loginForm: 'input[autocomplete="username"], [data-testid="loginButton"]',
  dialog: '[role="dialog"], [data-testid="sheetDialog"], [data-testid="ocfEnterTextTextInput"]',
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
  | { outcome: "signed-out" | "verify" | "wrong-account" | "error" | "unconfirmed"; message: string };

/** Creates the profile dir, private to this user, and returns it. */
export function ensureXProfileDir(dir: string = X_PROFILE_DIR): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** `start()` options for an X session: the caller's chromePath/port/display, never its profile
 * (the worker's `--profile-dir` is Studio's); the X profile, created 700 if missing. Every caller
 * resolves its options through this once; `postPlanViaBrowser` takes them as given (a test's own
 * throwaway profile included) and only falls back to the real X profile when handed none. */
export function xStartOpts(
  opts: StudioBrowserOptions = {},
  profileDir: string = X_PROFILE_DIR,
): StudioBrowserOptions {
  return { ...opts, profileDir: ensureXProfileDir(profileDir) };
}

export interface XDom {
  composer: boolean;
  loginForm: boolean;
  /** A dialog or sheet visible on the page. */
  dialog: boolean;
  /** The signed-in handle off the account switcher, or null when it cannot be read. */
  handle: string | null;
}

/**
 * Pure classification of a loaded page, unit-testable without a browser. A dialog or sheet over
 * the timeline is `verify` even with the composer beneath it (X's own login flow is a dialog too,
 * so only over `/home`). Then a visible composer or account menu is `ok` whatever the page text
 * says (a timeline quotes anything, "verify" included), but only signed in as `handle`, else
 * `wrong-account`; then a challenge/verification/CAPTCHA page; then X's own login flow; anything
 * else is `error`, since "ok" must be positively confirmed before the composer is touched.
 */
export function classifyX(
  url: string,
  text: string,
  dom: XDom,
  handle: string = config.xHandle,
): XProbeResult {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a URL (a test's bare path): classify the string as is.
  }
  if (dom.dialog && pathname === "/home") return "verify";
  if (dom.composer) return dom.handle?.toLowerCase() === handle.toLowerCase() ? "ok" : "wrong-account";
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

async function readDom(p: Page): Promise<XDom> {
  const visible = (sel: string) =>
    p
      .locator(sel)
      .filter({ visible: true })
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  const menu = p.locator(SEL.accountMenu).first();
  // The avatar's test id carries the handle (`UserAvatar-Container-<handle>`); the menu's own text
  // ("MCSR Replayoffs @mcsrreplayoffs") is the fallback.
  const avatar = await menu
    .locator(SEL.avatar)
    .first()
    .getAttribute("data-testid", { timeout: 1000 })
    .catch(() => null);
  const menuText = avatar ? "" : await menu.innerText({ timeout: 1000 }).catch(() => "");
  return {
    composer: (await visible(SEL.composer)) || (await visible(SEL.accountMenu)),
    loginForm: await visible(SEL.loginForm),
    dialog: await visible(SEL.dialog),
    handle: avatar
      ? avatar.slice("UserAvatar-Container-".length)
      : (/@(\w{1,15})/.exec(menuText)?.[1] ?? null),
  };
}

/** Loads the timeline and classifies the session; records the answer in `.x-browser.json`. */
export async function probeX(
  handle: StudioHandle,
  opts: Pick<XBrowserOptions, "home"> = {},
): Promise<{ result: XProbeResult; url: string; title: string; handle: string | null }> {
  const p = await pageOf(handle);
  const home = opts.home ?? X_HOME;
  await p.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // A login redirect or a challenge interstitial settles a few seconds after the first paint.
  await p.waitForTimeout(opts.home ? 500 : 5000);
  // Only a page on X's own origin is classified: a tab Chrome restored from the last session, or
  // a redirect off the site, throws here rather than being read as X.
  const origin = new URL(home).origin;
  await p.waitForURL((u) => u.origin === origin, { waitUntil: "commit", timeout: opts.home ? 2000 : 30_000 });
  const url = p.url();
  const title = await p.title().catch(() => "");
  const text = await p
    .locator("body")
    .innerText()
    .catch(() => "");
  const dom = await readDom(p);
  const result = classifyX(url, text, dom);
  updateXBrowserState({ lastProbe: result, lastProbeAt: new Date().toISOString() });
  return { result, url, title, handle: dom.handle };
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

/** The composer holds exactly `plan.text`, or this throws naming a screenshot of what it holds. */
async function checkTyped(p: Page, composer: Locator, plan: XPlan): Promise<void> {
  const typed = (await composer.innerText()).replace(/\u00a0/g, " ").trim();
  if (typed === plan.text.trim()) return;
  const shot = await shotX(p, plan.matchId, "compose");
  throw new Error(
    `the composer does not hold the planned text (it reads ${JSON.stringify(typed.slice(0, 60))}), see ${shot}`,
  );
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
 * After the click: X's "Your post was sent" toast or the post's status link on the timeline (an
 * emptied composer proves nothing). The link, or null when only the toast showed; throws on neither.
 */
async function confirmSent(p: Page, text: string, home: string): Promise<string | null> {
  const firstLine = text.split("\n")[0]!;
  const link = p.locator(`${SEL.article}:has-text(${JSON.stringify(firstLine)}) a[href*="/status/"]`).first();
  let url: string | null = null;
  const readLink = async (): Promise<boolean> => {
    const href = await link.getAttribute("href", { timeout: 1000 }).catch(() => null);
    if (href) url = new URL(href, home).toString();
    return url !== null;
  };
  const sent = await until(
    async () =>
      (await readLink()) || (await p.locator(`${SEL.toast}:has-text("Your post was sent")`).count()) > 0,
    30_000,
  );
  if (!sent) throw new Error('no "Your post was sent" and no status link after clicking Post');
  if (!url) await until(readLink, 20_000);
  return url;
}

/**
 * Drives the composer on an already-`ok` session: the text, checked; dry, a screenshot and the
 * composer emptied, nothing uploaded. Live: the clip, the text checked again, a screenshot,
 * `x.json` as `browser:pending`, the Post button, then the confirmation and X's id into `x.json`.
 * Throws on anything the page does not do before the click; after it, a missing confirmation is
 * the `unconfirmed` outcome. Nothing here retries.
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
  await checkTyped(p, composer, plan);
  if (opts.dryRun) {
    const screenshot = await shotX(p, plan.matchId, "compose");
    // Nothing left in the composer for X to keep as a draft once the browser closes.
    await composer.click({ timeout: 15_000 });
    await p.keyboard.press("ControlOrMeta+A");
    await p.keyboard.press("Delete");
    return { outcome: "dry-run", screenshot };
  }

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
  await checkTyped(p, composer, plan);
  await shotX(p, plan.matchId, "compose");

  // From the click on, the post may be out: x.json first, exclusively (a run that wrote one since
  // the check above wins), so planXPost and xTooSoon count it as posted whatever happens next.
  const pending: XRecord = {
    postId: PENDING_POST_ID,
    at: new Date().toISOString(),
    text: plan.text,
    mediaId: "",
    via: "browser",
  };
  await writeXRecord(plan.matchId, pending, "wx").catch((err: NodeJS.ErrnoException) => {
    throw err.code === "EEXIST" ? new XRefusal(`match ${plan.matchId} is already on X (x.json)`) : err;
  });
  let url: string | null;
  try {
    await button.click({ timeout: 15_000 });
    url = await confirmSent(p, plan.text, home);
  } catch (err) {
    await shotX(p, plan.matchId, "unconfirmed");
    return { outcome: "unconfirmed", message: describeError(err) };
  }
  const id = url ? /\/status\/(\d+)/.exec(url)?.[1] : undefined;
  const record: XRecord = { ...pending, postId: id ?? `browser:${Date.now()}`, at: new Date().toISOString() };
  await writeXRecord(plan.matchId, record);
  await shotX(p, plan.matchId, "posted");
  return { outcome: "posted", record, url };
}

/** `.x-browser.json` after an attempt: an `error` is `lastError`; any other outcome clears it. */
function recordOutcome(matchId: number, done: XBrowserOutcome): void {
  const at = new Date().toISOString();
  if (done.outcome === "error")
    updateXBrowserState({ lastError: done.message, lastErrorAt: at, lastMatchId: matchId });
  else if (done.outcome === "unconfirmed")
    updateXBrowserState({
      lastError: null,
      lastMatchId: matchId,
      unconfirmed: { matchId, at, error: done.message },
    });
  else if (done.outcome === "posted")
    updateXBrowserState({
      lastError: null,
      lastPostAt: done.record.at,
      lastMatchId: matchId,
      unconfirmed: null,
    });
  else updateXBrowserState({ lastError: null });
}

/**
 * One plan, its own browser session: start Chrome on the X profile, probe, post, stop. A non-`ok`
 * probe, a click X never confirmed or a thrown error (`start()`'s own included) is returned as the
 * outcome and written to `.x-browser.json`; the caller decides what to print. `startOpts` are X's
 * (`xStartOpts`), or a test's.
 */
export async function postPlanViaBrowser(
  plan: XPlan,
  opts: XBrowserOptions & { startOpts?: StudioBrowserOptions } = {},
): Promise<XBrowserOutcome> {
  if (existsSync(xFile(plan.matchId))) throw new XRefusal(`match ${plan.matchId} is already on X (x.json)`);
  let handle: StudioHandle | null = null;
  let done: XBrowserOutcome;
  try {
    handle = await start(opts.startOpts ?? xStartOpts());
    const probed = await probeX(handle, opts);
    const seen = `${probed.title} (${probed.url})`;
    if (probed.result === "ok") done = await postViaBrowser(handle, plan, opts);
    else if (probed.result === "error")
      done = { outcome: "error", message: `X did not load as expected: ${seen}` };
    else
      done = {
        outcome: probed.result,
        message: probed.result === "wrong-account" ? `${seen} as @${probed.handle ?? "?"}` : seen,
      };
  } catch (err) {
    if (err instanceof XRefusal) throw err;
    done = { outcome: "error", message: describeError(err) };
  } finally {
    await handle?.stop();
  }
  recordOutcome(plan.matchId, done);
  return done;
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
    case "wrong-account":
      return `X: not signed in as @${config.xHandle} (${done.message}), sign in with npm run x -- login`;
    case "unconfirmed":
      return `X: post may have gone out unconfirmed, check x.com/${config.xHandle}: ${done.message}`;
    case "error":
      return `X post failed: ${done.message}`;
  }
}

const isPending = (matchId: number): Promise<boolean> =>
  readFile(xFile(matchId), "utf8")
    .then((s) => (JSON.parse(s) as XRecord).postId === PENDING_POST_ID)
    .catch(() => false);

/**
 * The worker's (and `npm run x -- auto --via browser`'s) step. Idle while the API poster is armed
 * (never two posters); one failed attempt a UTC day; dry, one drive a UTC day; then `xTooSoon`
 * (one a UTC day and `xMinHoursBetweenPosts`, shared with the API poster) and the newest candidate
 * `pickXCandidate` lets through, posted through the browser. Returns one line for the log. Dry:
 * the text typed and screenshotted, nothing uploaded or clicked.
 */
export async function xBrowserTick(
  opts: XBrowserOptions & { startOpts?: StudioBrowserOptions; now?: number } = {},
): Promise<string> {
  if (config.xAutoPost && isXConfigured()) return "API poster is on; browser poster idle";
  const now = opts.now ?? Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const state = readXBrowserState();
  // The operator settled an unconfirmed click (X's id put in x.json, or x.json deleted): its line goes.
  if (state?.unconfirmed && !(await isPending(state.unconfirmed.matchId)))
    updateXBrowserState({ unconfirmed: null });
  if (state?.lastError && state.lastErrorAt?.slice(0, 10) === today)
    return `failed today, next try tomorrow: ${state.lastError.split("\n")[0]}`;
  if (opts.dryRun && state?.lastDryRunAt?.slice(0, 10) === today) return "dry run already done today";
  const tooSoon = await xTooSoon(now);
  const plan = tooSoon ? null : await pickXCandidate(now);
  if (!plan) {
    // Nothing attempted, so nothing failing: an earlier day's error is history.
    if (state?.lastError) updateXBrowserState({ lastError: null });
    return tooSoon ?? "nothing to post";
  }
  if (opts.dryRun) updateXBrowserState({ lastDryRunAt: new Date(now).toISOString() });
  const done = await postPlanViaBrowser(plan, opts);
  return `match ${plan.matchId}: ${describeOutcome(done)}`;
}
