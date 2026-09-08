// Dashboard smoke test. Usage: node smoke.cjs http://host:port [outPrefix]
// Fails (exit 1) on page errors, console errors, or any assertion below; writes screenshots.
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://mcsr-dashboard:8080";
const OUT = process.argv[3] || require("path").join(require("os").tmpdir(), "smoke");
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const problems = [];
  const note = (s) => problems.push(s);
  for (const [tag, vp] of [
    ["desk", { width: 1280, height: 900 }],
    ["mob", { width: 390, height: 844 }],
  ]) {
    const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => note(`${tag}: pageerror ${e.message.split("\n")[0]}`));
    p.on("console", (m) => {
      if (m.type() === "error") note(`${tag}: console ${m.text().slice(0, 140)}`);
    });
    p.on("response", (r) => {
      if (r.status() >= 400) note(`${tag}: ${r.status()} ${r.url().replace(BASE, "")}`);
    });
    await p.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45000 });
    // Suggestions tab renders cards without throwing (splitsChart must be defined).
    await p.click("#tab-suggestions");
    await p.waitForTimeout(1200);
    const cards = await p.locator(".sugg").count();
    if (cards === 0) note(`${tag}: no suggestion cards rendered`);
    if (cards && !(await p.locator(".sugg .story").count()))
      note(`${tag}: suggestion cards have no story line`);
    if (cards && (await p.locator(".sugg").first().innerText()).match(/score \d/))
      note(`${tag}: raw score still shown on a card`);
    if (await p.locator(".sugg svg.splitschart text").count())
      note(`${tag}: compact chart still renders text labels`);
    await p.screenshot({ path: `${OUT}-${tag}-sugg.png`, fullPage: true });
    // Rendered tab + detail.
    await p.click("#tab-matches");
    await p.waitForTimeout(800);
    if ((await p.locator(".card").count()) === 0) note(`${tag}: no rendered matches listed`);
    await p.locator(".card").first().click();
    await p.waitForTimeout(2500);
    if (!(await p.locator("#splits svg").count())) note(`${tag}: splits chart missing on detail`);
    if (tag === "mob") {
      if (!(await p.locator("#backtolist").isVisible()))
        note("mob: back bar not visible on the match screen");
      if (await p.locator("#left").isVisible()) note("mob: sidebar still visible on the match screen");
    } else if (await p.locator("#backtolist").isVisible()) note("desk: back bar visible on desktop");
    if ((await p.locator(".variant").count()) && !(await p.locator("#rerender").count()))
      note(`${tag}: thumbnail variants shown but no re-render control`);
    // Hook -> YouTube title sync + upload guard.
    if (await p.locator("#hook").count()) {
      await p.fill("#hook", "WANNABE vs REAL GOAT");
      await p.waitForTimeout(500);
      const yt = await p.inputValue("#ytTitle").catch(() => null);
      if (yt !== null && yt.includes("<HOOK>"))
        note(`${tag}: #ytTitle still has <HOOK> after typing a hook: "${yt}"`);
      const upBtn = p.locator("button", { hasText: /^Upload$/ }).first();
      if (await upBtn.count()) {
        await p.fill("#ytTitle", "<HOOK> | x vs y");
        await p.waitForTimeout(300);
        if (!(await upBtn.isDisabled())) note(`${tag}: Upload is enabled while title contains <HOOK>`);
      }
    }
    await p.screenshot({ path: `${OUT}-${tag}-detail.png`, fullPage: true });
    await ctx.close();
  }
  await b.close();
  console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "smoke: clean");
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL", e.message.split("\n")[0]);
  process.exit(1);
});
