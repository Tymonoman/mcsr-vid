// Integration self-check for src/x/xBrowser.ts: a real Chrome, headed, on Xvfb, over CDP, exactly
// as studioActions.test.ts does — against a local node:http fixture that mimics x.com's composer
// (a contenteditable, a file input, a Post button that appends an article with a status link) and
// its login page. No page here ever leaves 127.0.0.1. Skipped (exit 0) without Xvfb/Chromium.
// Run: npx tsx src/x/xBrowser.test.ts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { config } = await import("../config.js");
config.mediaDir = media;
const { classifyX, postPlanViaBrowser, postViaBrowser, probeX, xStartOpts } = await import("./xBrowser.js");
const { readXBrowserState, xBrowserNeedsYou } = await import("./xBrowserState.js");
const { XRefusal } = await import("./xPost.js");
const { start, page: pageOf } = await import("../youtube/studioBrowser.js");

// --- the fixture: x.com's composer and login page, served locally ------------------------------
const HOME_HTML = `<!doctype html><html><body>
<style>[data-testid=fileInput]{display:none} .editor{min-height:40px;border:1px solid #888;padding:6px}</style>
<nav><div data-testid="SideNav_AccountSwitcher_Button">@fixture</div></nav>
<div data-testid="toast" id="toast" style="display:none"></div>
<div class="editor" data-testid="tweetTextarea_0" contenteditable="true"></div>
<input type="file" data-testid="fileInput">
<div id="att"></div>
<button data-testid="tweetButtonInline" disabled>Post</button>
<section id="timeline"></section>
<script>
  const ed = document.querySelector('[data-testid="tweetTextarea_0"]');
  const att = document.getElementById("att");
  const btn = document.querySelector('[data-testid="tweetButtonInline"]');
  const toast = document.getElementById("toast");
  let processing = false;
  const sync = () => { btn.disabled = !ed.innerText.trim() || processing; };
  ed.addEventListener("input", sync);
  document.querySelector('[data-testid="fileInput"]').addEventListener("change", (e) => {
    const f = e.target.files[0];
    processing = true;
    att.innerHTML = '<div data-testid="attachments"><div role="progressbar">Uploading ' + f.name + '</div></div>';
    sync();
    setTimeout(() => { att.querySelector('[role=progressbar]').remove(); processing = false; sync(); }, 400);
  });
  btn.addEventListener("click", async () => {
    const text = ed.innerText;
    await fetch("/posted", { method: "POST", body: text });
    const a = document.createElement("article");
    a.setAttribute("data-testid", "tweet");
    a.innerHTML = '<div style="white-space:pre-wrap"></div><a href="/fixture/status/1849000000000000001">1h</a>';
    a.firstChild.textContent = text;
    document.getElementById("timeline").prepend(a);
    ed.innerHTML = ""; att.innerHTML = ""; sync();
    toast.textContent = "Your post was sent."; toast.style.display = "block";
  });
</script></body></html>`;
const LOGIN_HTML = `<!doctype html><html><body><h1>Sign in to X</h1>
<input autocomplete="username" name="text" placeholder="Phone, email, or username"><button>Next</button></body></html>`;
const VERIFY_HTML = `<!doctype html><html><body><h1>Verify your identity</h1><p>Enter your phone number</p></body></html>`;

let mode: "in" | "out" | "verify" = "in";
const posted: string[] = [];
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/posted") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posted.push(body);
      res.end("ok");
    });
    return;
  }
  if (url.pathname === "/home" && mode === "out") {
    res.writeHead(302, { location: "/i/flow/login" });
    return res.end();
  }
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/i/flow/login") return res.end(LOGIN_HTML);
  if (url.pathname === "/home") return res.end(mode === "verify" ? VERIFY_HTML : HOME_HTML);
  res.statusCode = 404;
  res.end("nope");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const home = `http://127.0.0.1:${port}/home`;
process.on("exit", () => server.close());

// --- classifyX, pure -------------------------------------------------------------------------------
assert.equal(classifyX("https://x.com/home", "verify your identity in a quoted post", { composer: true, loginForm: false }), "ok");
assert.equal(classifyX("https://x.com/i/flow/login", "Sign in to X", { composer: false, loginForm: true }), "signed-out");
assert.equal(classifyX("https://x.com/home", "", { composer: false, loginForm: true }), "signed-out");
assert.equal(classifyX("https://x.com/account/access", "", { composer: false, loginForm: false }), "verify");
assert.equal(classifyX("https://x.com/home", "Confirm your email address", { composer: false, loginForm: false }), "verify");
assert.equal(classifyX("https://x.com/i/flow/login_challenge", "", { composer: false, loginForm: false }), "verify");
assert.equal(classifyX("https://x.com/home", "Something went wrong", { composer: false, loginForm: false }), "error");
console.log("OK: classifyX — composer wins, then verify, then login, else error");

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
const startOpts = xStartOpts({ chromePath, debugPort: 9295, display: ":96", extraArgs: ["--no-sandbox"] }, profileDir);
const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
const shots = () => readdirSync(path.join(media, String(matchId))).filter((f) => f.startsWith("x-"));

// 1. Signed out: the probe says so, nothing is typed, nothing retried, no x.json; Needs-you has a line.
mode = "out";
const out = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(out.outcome, "signed-out", JSON.stringify(out));
assert.equal(readXBrowserState()?.lastProbe, "signed-out");
assert.ok(!existsSync(path.join(media, "1", "x.json")));
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), true), ["X: signed out, sign in with npm run x -- login"]);
assert.deepEqual(xBrowserNeedsYou(readXBrowserState(), false), [], "the flag off: no line");
console.log("OK: a signed-out session is the outcome, recorded, and never retried or logged into");

// 2. A verification page is `verify`, never driven.
mode = "verify";
const ver = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(ver.outcome, "verify", JSON.stringify(ver));
assert.match(xBrowserNeedsYou(readXBrowserState(), true)[0]!, /verification prompt/);
console.log("OK: a verification page is `verify`, with its Needs-you line");

// 3. Dry run: the whole drive — text, clip, processing wait, screenshot — then stops before Post.
mode = "in";
const dry = await postPlanViaBrowser(plan, { startOpts, home, pace, dryRun: true });
assert.equal(dry.outcome, "dry-run", JSON.stringify(dry));
assert.equal(posted.length, 0, "the Post button was never clicked");
assert.ok(dry.outcome === "dry-run" && existsSync(dry.screenshot), "x-compose screenshot on disk");
assert.ok(shots().some((f) => f.startsWith("x-compose-")));
assert.ok(!existsSync(path.join(media, "1", "x.json")));
assert.equal(readXBrowserState()?.lastProbe, "ok");
console.log("OK: dry run attaches the clip, screenshots the composer and stops before the click");

// 4. Live: the click, the toast, the article's status link, x.json with via:"browser", the state file.
const live = await postPlanViaBrowser(plan, { startOpts, home, pace });
assert.equal(live.outcome, "posted", JSON.stringify(live));
assert.equal(posted.length, 1);
assert.ok(posted[0]!.includes("ONE PEARL FROM THE END | Alpha vs Bravo") && posted[0]!.includes("https://youtu.be/vid1"), posted[0]);
const record = JSON.parse(readFileSync(path.join(media, "1", "x.json"), "utf8"));
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
console.log("OK: a live post clicks Post, reads the status id off the timeline and writes x.json via:browser");

// 5. Already posted: refused before any browser starts, and inside the drive too.
await assert.rejects(postPlanViaBrowser(plan, { startOpts, home, pace }), (e: unknown) => e instanceof XRefusal && /already on X/.test(e.message));
const handle = await start(startOpts);
try {
  await assert.rejects(postViaBrowser(handle, plan, { home, pace }), XRefusal);
  // A probe on a live handle, for `npm run x -- probe`.
  assert.equal((await probeX(handle, { home })).result, "ok");
  assert.equal(await (await pageOf(handle)).locator('[data-testid="tweetTextarea_0"]').innerText(), "");
} finally {
  await handle.stop();
}
assert.equal(posted.length, 1, "nothing posted twice");
console.log("OK: a match with x.json is refused by both entry points; nothing is posted twice");

// 6. A page error (the fixture 404s) is an `error` outcome with lastError, never a retry or a post.
posted.length = 0;
rmSync(path.join(media, "1", "x.json"));
const broken = await postPlanViaBrowser(plan, { startOpts, home: `http://127.0.0.1:${port}/gone`, pace });
assert.equal(broken.outcome, "error", JSON.stringify(broken));
assert.equal(posted.length, 0);
assert.ok(!existsSync(path.join(media, "1", "x.json")));
console.log("OK: an unreadable page is an error outcome, no post, no retry");

console.log("xBrowser: all OK");
