// Integration self-check for src/x/xBrowser.ts: a real Chrome, headed, on Xvfb, over CDP, exactly
// as studioActions.test.ts does — against a local node:http fixture that mimics x.com's composer
// (a contenteditable, a file input, a Post button that appends an article with a status link), its
// login page and the ways a session or a post goes wrong. No page here ever leaves 127.0.0.1.
// Skipped (exit 0) without Xvfb/Chromium.
// Run: npx tsx src/x/xBrowser.test.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { XPlan } from "./xPost.js";

function xvfbAvailable(): boolean {
  try {
    execSync("command -v Xvfb", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function chromiumPath(): string | null {
  try {
    const exe = chromium.executablePath();
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}
const chromePath = chromiumPath();
if (!xvfbAvailable() || !chromePath) {
  console.log(
    `xBrowser: skipped — ${!xvfbAvailable() ? "Xvfb" : "no Chromium binary (run `npx playwright install chromium`)"} not available here`,
  );
  process.exit(0);
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-x-fixture-"));
const profileDir = mkdtempSync(path.join(tmpdir(), "mcsr-x-profile-"));
process.on("exit", () => {
  rmSync(media, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});
// The real profile must never be touched by a test (22 Oct 2026: a first version re-resolved the
// test's options through xStartOpts and ran Chromium against /app/.x-profile).
const realProfile = path.join(media, "never-created-x-profile");
process.env.X_PROFILE_DIR = realProfile;
const { config } = await import("../config.js");
config.mediaDir = media;
const { classifyX, PENDING_POST_ID, postPlanViaBrowser, postViaBrowser, probeX, xStartOpts } =
  await import("./xBrowser.js");
const { readXBrowserState, xBrowserNeedsYou } = await import("./xBrowserState.js");
const { XRefusal } = await import("./xPost.js");
const { start, page: pageOf } = await import("../youtube/studioBrowser.js");

// --- the fixture: x.com's composer and login page, served locally ------------------------------
type Mode = "in" | "out" | "verify" | "sheet" | "other" | "nohash" | "late" | "silent";
/** The timeline with the composer. `sheet` lays a sheet over it, `other` is another account,
 * `nohash` drops every "#" typed, `late` changes the text once the clip is attached, `silent`
 * takes the post (it reaches /posted) but shows neither the toast nor the article. */
const homeHtml = (mode: Mode) => `<!doctype html><html><body>
<style>[data-testid=fileInput]{display:none} .editor{min-height:40px;border:1px solid #888;padding:6px}</style>
<nav><div data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-${mode === "other" ? "someoneelse" : "MCSRReplayoffs"}"></div>MCSR Replayoffs</div></nav>
${mode === "sheet" ? '<div data-testid="sheetDialog" style="position:fixed;top:20%;left:20%;background:#fff;border:1px solid">Confirm your phone number</div>' : ""}
<div data-testid="toast" id="toast" style="display:none"></div>
<div class="editor" data-testid="tweetTextarea_0" contenteditable="true"></div>
<input type="file" data-testid="fileInput">
<div id="att"></div>
<button data-testid="tweetButtonInline" disabled>Post</button>
<section id="timeline"></section>
<script>
  const MODE = ${JSON.stringify(mode)};
  const ed = document.querySelector('[data-testid="tweetTextarea_0"]');
  const att = document.getElementById("att");
  const btn = document.querySelector('[data-testid="tweetButtonInline"]');
  const toast = document.getElementById("toast");
  let processing = false;
  const sync = () => { btn.disabled = !ed.innerText.trim() || processing; };
  ed.addEventListener("input", sync);
  ed.addEventListener("keydown", (e) => { if (MODE === "nohash" && e.key === "#") e.preventDefault(); });
  document.querySelector('[data-testid="fileInput"]').addEventListener("change", (e) => {
    const f = e.target.files[0];
    fetch("/uploaded", { method: "POST", body: f.name });
    processing = true;
    att.innerHTML = '<div data-testid="attachments"><div role="progressbar">Uploading ' + f.name + '</div></div>';
    if (MODE === "late") ed.append(" and more");
    sync();
    setTimeout(() => { att.querySelector('[role=progressbar]').remove(); processing = false; sync(); }, 400);
  });
  btn.addEventListener("click", async () => {
    const text = ed.innerText;
    await fetch("/posted", { method: "POST", body: text });
    ed.innerHTML = ""; att.innerHTML = ""; sync();
    if (MODE === "silent") return;
    const a = document.createElement("article");
    a.setAttribute("data-testid", "tweet");
    a.innerHTML = '<div style="white-space:pre-wrap"></div><a href="/fixture/status/1849000000000000001">1h</a>';
    a.firstChild.textContent = text;
    document.getElementById("timeline").prepend(a);
    toast.textContent = "Your post was sent."; toast.style.display = "block";
  });
</script></body></html>`;
// X's own login flow is a dialog too: only a dialog over /home reads as a verification step.
const LOGIN_HTML = `<!doctype html><html><body><div role="dialog"><h1>Sign in to X</h1>
<input autocomplete="username" name="text" placeholder="Phone, email, or username"><button>Next</button></div></body></html>`;
const VERIFY_HTML = `<!doctype html><html><body><h1>Verify your identity</h1><p>Enter your phone number</p></body></html>`;

let mode: Mode = "in";
const posted: string[] = [];
/** x.json's postId at the moment each post reached the fixture: written before the click. */
const pendingAtClick: (string | null)[] = [];
let uploads = 0;
const xJson = path.join(media, "1", "x.json");
let elsewhere = ""; // the second server's origin, a redirect target off the first one's
const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/uploaded") uploads++;
      if (url.pathname === "/posted") {
        posted.push(body);
        pendingAtClick.push(existsSync(xJson) ? JSON.parse(readFileSync(xJson, "utf8")).postId : null);
      }
      res.end("ok");
    });
    return;
  }
  if (url.pathname === "/home" && mode === "out") {
    res.writeHead(302, { location: "/i/flow/login" });
    return res.end();
  }
  if (url.pathname === "/away") {
    res.writeHead(302, { location: `${elsewhere}/home` });
    return res.end();
  }
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/i/flow/login") return res.end(LOGIN_HTML);
  if (url.pathname === "/home") return res.end(mode === "verify" ? VERIFY_HTML : homeHtml(mode));
  res.statusCode = 404;
  res.end("nope");
};
const listen = async (): Promise<number> => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref(); // the fixture must not keep the process alive once the checks are done
  return (server.address() as { port: number }).port;
};
const port = await listen();
elsewhere = `http://127.0.0.1:${await listen()}`;
const home = `http://127.0.0.1:${port}/home`;

// --- classifyX, pure -------------------------------------------------------------------------------
const dom = (o: Partial<import("./xBrowser.js").XDom> = {}) => ({
  composer: false,
  loginForm: false,
  dialog: false,
  handle: null,
  ...o,
});
const me = { composer: true, handle: "MCSRReplayoffs" };
assert.equal(
  classifyX("https://x.com/home", "verify your identity in a quoted post", dom(me)),
  "ok",
  "case-insensitive handle",
);
assert.equal(classifyX("https://x.com/home", "", dom({ ...me, handle: "someoneelse" })), "wrong-account");
assert.equal(
  classifyX("https://x.com/home", "", dom({ composer: true })),
  "wrong-account",
  "an unread handle is never ok",
);
assert.equal(
  classifyX("https://x.com/home", "", dom({ ...me, dialog: true })),
  "verify",
  "a sheet over the timeline",
);
assert.equal(
  classifyX("https://x.com/i/flow/login", "Sign in to X", dom({ loginForm: true, dialog: true })),
  "signed-out",
  "the login flow's own dialog is not a verification step",
);
assert.equal(classifyX("https://x.com/home", "", dom({ loginForm: true })), "signed-out");
assert.equal(classifyX("https://x.com/account/access", "", dom()), "verify");
assert.equal(classifyX("https://x.com/home", "Confirm your email address", dom()), "verify");
assert.equal(classifyX("https://x.com/i/flow/login_challenge", "", dom()), "verify");
assert.equal(classifyX("https://x.com/home", "Something went wrong", dom()), "error");
console.log(
  "OK: classifyX — a sheet over /home is verify, then the composer as @xHandle only, then verify, login, error",
);

// --- the drive ----------------------------------------------------------------------------------
const matchId = 1;
mkdirSync(path.join(media, String(matchId)), { recursive: true });
const clipPath = path.join(media, String(matchId), `short-${matchId}.mp4`);
writeFileSync(clipPath, Buffer.from("not really an mp4"));
const plan: XPlan = {
  matchId,
  text: "ONE PEARL FROM THE END | Alpha vs Bravo\nhttps://youtu.be/vid1\n#mcsr #minecraft",
  clipPath,
  videoId: "vid1",
};
// Test-only: this container has no usable Chromium sandbox (studioActions.test.ts says why).
const display = ":85";
const startOpts = xStartOpts(
  { chromePath, debugPort: 9351, display, extraArgs: ["--no-sandbox"] },
  profileDir,
);
const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
const shots = () => readdirSync(path.join(media, String(matchId))).filter((f) => f.startsWith("x-"));
const nothingSent = (why: string) => {
  assert.equal(posted.length, 0, `${why}: never clicked`);
  assert.ok(!existsSync(xJson), `${why}: no x.json`);
};

// 1. Signed out: the probe says so, nothing is typed, nothing retried, no x.json; Needs-you has a line.
mode = "out";
const out = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(out.outcome, "signed-out", JSON.stringify(out));
assert.equal(readXBrowserState()?.lastProbe, "signed-out");
nothingSent("signed out");
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X: signed out, sign in with npm run x -- login",
]);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), false), [], "the flag off: no line");
console.log("OK: a signed-out session is the outcome, recorded, and never retried or logged into");

// 2. A verification page, or a sheet laid over the timeline, is `verify`, never driven.
for (const m of ["verify", "sheet"] as const) {
  mode = m;
  const ver = await postPlanViaBrowser(plan, { startOpts, home, pace });
  assert.equal(ver.outcome, "verify", `${m}: ${JSON.stringify(ver)}`);
  assert.match(xBrowserNeedsYou(readXBrowserState(), true)[0]!, /verification prompt/);
}
assert.equal(uploads, 0);
nothingSent("verify");
console.log("OK: a verification page or a sheet over the timeline is `verify`, with its Needs-you line");

// 3. Signed in as someone else: `wrong-account`, never driven, its own Needs-you line.
mode = "other";
const other = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(other.outcome, "wrong-account", JSON.stringify(other));
assert.ok(
  other.outcome === "wrong-account" && other.message.endsWith("as @someoneelse"),
  JSON.stringify(other),
);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X: the browser is not signed in as @mcsrreplayoffs, sign in with npm run x -- login",
]);
nothingSent("another account");
console.log("OK: another account's session is `wrong-account`, never driven");

// 4. A page off the timeline's origin (a restored tab, a redirect away) is never classified, even
// one that looks exactly like a signed-in timeline.
mode = "in";
const away = await postPlanViaBrowser(plan, { startOpts, home: `http://127.0.0.1:${port}/away`, pace });
assert.equal(away.outcome, "error", JSON.stringify(away));
assert.match(readXBrowserState()?.lastError ?? "", /waitForURL/);
nothingSent("off origin");
console.log("OK: a page that lands off X's origin is an error, never read as the timeline");

// 5. start() failing (a Chrome already up) is recorded like any other failure; the dry run on a live
// handle types, checks and screenshots, uploads nothing and leaves the composer empty; stop()
// returns only once Xvfb has exited (its display lock gone).
const handle = await start(startOpts);
try {
  const busy = await postPlanViaBrowser(plan, { startOpts, home, pace });
  assert.equal(busy.outcome, "error", JSON.stringify(busy));
  assert.match(readXBrowserState()?.lastError ?? "", /already running/);
  assert.equal((await probeX(handle, { home })).result, "ok");
  const dry = await postViaBrowser(handle, plan, { home, pace, dryRun: true });
  assert.ok(dry.outcome === "dry-run" && existsSync(dry.screenshot), JSON.stringify(dry));
  const p = await pageOf(handle);
  assert.equal(
    (await p.locator('[data-testid="tweetTextarea_0"]').innerText()).trim(),
    "",
    "the composer is emptied",
  );
  assert.equal(await p.locator('[data-testid="attachments"]').count(), 0);
} finally {
  await handle.stop();
}
assert.ok(!existsSync(`/tmp/.X${display.slice(1)}-lock`), "Xvfb has exited by the time stop() returns");
assert.equal(uploads, 0, "a dry run uploads nothing");
nothingSent("dry run");
assert.ok(shots().some((f) => f.startsWith("x-compose-")));
console.log("OK: a start() failure lands in lastError; a dry run uploads nothing and empties the composer");

// 6. The composer not holding the planned text, before the clip or after it: an error with the
// compose screenshot, never a click.
for (const m of ["nohash", "late"] as const) {
  mode = m;
  const bad = await postPlanViaBrowser(plan, { startOpts, home, pace });
  assert.equal(bad.outcome, "error", `${m}: ${JSON.stringify(bad)}`);
  assert.ok(
    bad.outcome === "error" && /does not hold the planned text.*x-compose-/.test(bad.message),
    bad.message,
  );
  assert.equal(
    uploads,
    m === "nohash" ? 0 : 1,
    `${m}: checked ${m === "nohash" ? "before" : "after"} the upload`,
  );
}
nothingSent("wrong text");
console.log(
  "OK: text the composer does not hold exactly stops the drive before the upload and again before the click",
);

// 7. A dry run through the whole entry point: a clean outcome clears the last error.
mode = "in";
const dry = await postPlanViaBrowser(plan, { startOpts, home, pace, dryRun: true });
assert.equal(dry.outcome, "dry-run", JSON.stringify(dry));
assert.equal(readXBrowserState()?.lastError, null);
assert.equal(readXBrowserState()?.lastProbe, "ok");
nothingSent("dry run");
console.log("OK: a clean dry run clears lastError");

// 8. Live: x.json is browser:pending when the click lands, then X's id off the article.
const live = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(live.outcome, "posted", JSON.stringify(live));
assert.equal(posted.length, 1);
assert.deepEqual(pendingAtClick, [PENDING_POST_ID], "x.json was written before the click");
assert.equal(posted[0]!.trim(), plan.text);
const record = JSON.parse(readFileSync(xJson, "utf8"));
assert.equal(record.via, "browser");
assert.equal(record.postId, "1849000000000000001");
assert.equal(record.text, plan.text);
assert.ok(live.outcome === "posted" && live.url?.endsWith("/fixture/status/1849000000000000001"));
assert.ok(shots().some((f) => f.startsWith("x-posted-")));
const state = readXBrowserState()!;
assert.equal(state.lastMatchId, 1);
assert.equal(state.lastError, null);
assert.ok(state.lastPostAt);
assert.deepEqual(xBrowserNeedsYou(state, true), [], "a clean post: nothing for the operator");
console.log("OK: a live post writes x.json browser:pending before the click, then X's id off the timeline");

// 9. Already posted: refused before any browser starts, and inside the drive too.
await assert.rejects(
  postPlanViaBrowser(plan, { startOpts, home, pace }),
  (e: unknown) => e instanceof XRefusal && /already on X/.test(e.message),
);
const again = await start(startOpts);
try {
  await assert.rejects(postViaBrowser(again, plan, { home, pace }), XRefusal);
} finally {
  await again.stop();
}
assert.equal(posted.length, 1, "nothing posted twice");
console.log("OK: a match with x.json is refused by both entry points; nothing is posted twice");

// 10. A click X never confirms (the composer empties, but no toast, no article): `unconfirmed`,
// x.json stays browser:pending so nothing posts it again, and the operator is told to look.
rmSync(xJson);
posted.length = 0;
pendingAtClick.length = 0;
mode = "silent";
const silent = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(silent.outcome, "unconfirmed", JSON.stringify(silent));
assert.equal(posted.length, 1, "the click went");
assert.equal(JSON.parse(readFileSync(xJson, "utf8")).postId, PENDING_POST_ID);
assert.equal(readXBrowserState()?.unconfirmed?.matchId, 1);
assert.match(readXBrowserState()?.unconfirmed?.error ?? "", /no "Your post was sent" and no status link/);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), [
  "X: post may have gone out unconfirmed, check x.com/mcsrreplayoffs (match 1)",
]);
assert.ok(shots().some((f) => f.startsWith("x-unconfirmed-")));
await assert.rejects(postPlanViaBrowser(plan, { startOpts, home, pace }), XRefusal);
assert.equal(posted.length, 1, "an unconfirmed post is never retried");
console.log("OK: an unconfirmed click stays browser:pending, is never retried, and has its Needs-you line");

// 11. A page error (the fixture 404s) is an `error` outcome with lastError, never a retry or a post.
posted.length = 0;
rmSync(xJson);
mode = "in";
const broken = await postPlanViaBrowser(plan, { startOpts, home: `http://127.0.0.1:${port}/gone`, pace });
assert.equal(broken.outcome, "error", JSON.stringify(broken));
assert.match(readXBrowserState()?.lastError ?? "", /did not load as expected/);
nothingSent("404");
console.log("OK: an unreadable page is an error outcome with lastError, no post, no retry");

// 12. The next confirmed post clears both the error and the unconfirmed line.
const next = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(next.outcome, "posted", JSON.stringify(next));
assert.equal(readXBrowserState()?.lastError, null);
assert.equal(readXBrowserState()?.unconfirmed, null);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), []);
console.log("OK: a confirmed post clears lastError and the unconfirmed line");

assert.ok(!existsSync(realProfile), "the real X profile dir was never created by a test");
console.log("xBrowser: all OK");
