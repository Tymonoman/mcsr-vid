const { chromium } = require("./launch.cjs");
const { firefox } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

/* The match screen has an address: `#match=<id>` opens that match on its Now panel (the link the
   Telegram report carries), opening a match writes it, going back to the list clears it, a reload
   keeps it, an id the list does not have is the list, and the page's own writes add no history
   entry. At desktop and phone width.
   Usage: [BROWSER=firefox] node deep-link-check.cjs <base> [shots dir]
   Two matches already on the channel are used (shortState published or scheduled, exported):
   opening one cannot queue a model pick. Nothing but GETs reaches the server: every other request
   is aborted and fails the check, and so is the plan GET of a match that could queue a pick (a
   boot without a link paints the first card behind the list).
   PUBLIC_DIR=<checkout>/public serves the page's scripts and styles from that checkout (still
   GETs, answered in the browser; the HTML stays the server's): a branch's client against a server
   that is still on main. Delete is never pressed: its path is read, not run. */
(async () => {
  const [base, shots] = process.argv.slice(2);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const rows = (await (await fetch(`${base}/api/matches`)).json()).matches;
  const onChannel = rows.filter(
    (m) => !m.hidden && m.exported && (m.shortState === "published" || m.shortState === "scheduled"),
  );
  if (onChannel.length < 2) {
    console.log(`SKIP deep-link: ${onChannel.length} matches on the channel, the check needs two`);
    return;
  }
  const [A, B] = onChannel.map((m) => m.matchId);
  // Opening an exported match with no pick that is not on the channel queues a model watch
  // (shortPlan); a row whose detail names the pick's window ("Short 6:21–7:02, …") has one.
  const noPlan = new Set(
    rows
      .filter((m) => m.exported && !m.uploaded && !/^Short (game \d+ )?\d+:\d\d–/.test(m.shortDetail ?? ""))
      .map((m) => String(m.matchId)),
  );
  /** Every non-GET request any page made: [viewport, method, path]. */
  const writes = [];

  const browser = await (process.env.BROWSER === "firefox" ? firefox : chromium).launch();
  try {
    for (const [vp, viewport] of [
      ["desktop", { width: 1400, height: 1000 }],
      ["phone", { width: 390, height: 844 }],
    ]) {
      const ctx = await browser.newContext({ viewport, hasTouch: vp === "phone" });
      await ctx.route("**/*", (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname;
        if (req.method() !== "GET" && req.method() !== "HEAD") {
          writes.push([vp, req.method(), p]);
          return route.abort();
        }
        if (/^\/api\/shorts\/plan\//.test(p) && noPlan.has(p.split("/").pop())) return route.abort();
        // Not the document: one fulfilled here has no address, and Chromium then blocks its fetches
        // to a private-network server (Private Network Access).
        const local =
          process.env.PUBLIC_DIR && req.resourceType() !== "document" && path.join(process.env.PUBLIC_DIR, p);
        if (local && !p.startsWith("/api/") && fs.existsSync(local) && fs.statSync(local).isFile())
          return route.fulfill({ path: local });
        return route.continue();
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));

      const hash = () => page.evaluate(() => location.hash);
      const panel = () => page.evaluate(() => document.querySelector("#detail .panel.on")?.dataset.panel);
      const inList = () => page.evaluate(() => !document.body.classList.contains("view-match"));
      const historyLength = () => page.evaluate(() => history.length);
      const tab = (name) => page.click(`#tab-${name}`);
      /** Off the match screen: a phone's bottom bar is the section bar there, its way back is the button. */
      const back = () => (vp === "phone" ? page.click("#backtolist") : tab("matches"));
      /** The screen as painted so far is the last one's: select() leaves it up until the match's own answer rebuilds it. */
      const markOld = () =>
        page.evaluate(() => document.querySelector("#detail .head")?.setAttribute("data-old", "1"));
      /** Until that match is the one on the match screen, rebuilt since markOld; false when it never is. */
      const onScreen = (id) =>
        page
          .waitForFunction(
            (id) =>
              document.body.classList.contains("view-match") &&
              document.querySelector("#detail .head:not([data-old]) .id")?.textContent.includes(`#${id}`),
            id,
            { timeout: 30000 },
          )
          .then(
            () => true,
            () => false,
          );
      /** A fresh document: goto alone treats a change of fragment as the same page. */
      const boot = async (url) => {
        await page.goto("about:blank");
        await page.goto(url, { waitUntil: "domcontentloaded" });
      };
      const shot = async (what) => {
        if (shots) await page.screenshot({ path: `${shots}/deep-link-${vp}-${what}.png` });
      };

      /* --- A link opens its match, on Now ----------------------------------------------------- */
      await boot(`${base}/#match=${A}`);
      const opened = await onScreen(A);
      check(`${vp}: #match=<id> opens that match`, opened, `#${A}`);
      if (!opened) throw new Error("the link did not open its match");
      check(`${vp}: on its Now panel`, (await panel()) === "now" && (await page.locator("#now").isVisible()));
      check(
        `${vp}: with Rendered underneath, so the way back is the list it is in`,
        (await page.getAttribute("#tab-matches", "aria-selected")) === "true",
      );
      check(`${vp}: the address still names it`, (await hash()) === `#match=${A}`, await hash());
      await page.waitForSelector("#now .step", { timeout: 30000 });
      await page.waitForTimeout(400);
      await shot("linked");

      await page.reload({ waitUntil: "domcontentloaded" });
      check(`${vp}: a reload keeps the open match`, (await onScreen(A)) && (await hash()) === `#match=${A}`);
      check(`${vp}: and opens it on Now`, (await panel()) === "now");
      const entries = await historyLength();

      /* --- The section bar leaves the address alone; the way back clears it ------------------- */
      if (vp === "phone") {
        await page.click('#detail .jump a[data-panel="check"]');
        check(
          `${vp}: a section tap keeps it`,
          (await panel()) === "check" && (await hash()) === `#match=${A}`,
        );
      }
      await back();
      check(
        `${vp}: the way back shows the Rendered list and clears the address`,
        (await inList()) && (await page.locator("#list").isVisible()) && (await hash()) === "",
      );

      /* --- Opening a match from the list writes it -------------------------------------------- */
      await tab("matches");
      await page.click(`#list .card[data-id="${B}"] .who`);
      check(`${vp}: a tapped row opens its match`, await onScreen(B));
      check(`${vp}: and the address names it`, (await hash()) === `#match=${B}`, await hash());
      await back();
      check(`${vp}: the way back clears it`, (await inList()) && (await hash()) === "");
      check(
        `${vp}: none of that added a history entry`,
        (await historyLength()) === entries,
        `${entries} -> ${await historyLength()}`,
      );

      /* --- A link followed in the open page opens on Now, not where the match was left -------- */
      await page.evaluate((id) => (location.hash = `#match=${id}`), A);
      check(`${vp}: a hash typed in the open page opens its match`, await onScreen(A));
      await page.evaluate(() => showPanel("package"));
      await back();
      await markOld();
      await page.evaluate((id) => (location.hash = `#match=${id}`), A);
      await onScreen(A);
      check(`${vp}: the match just left in Package opens on Now`, (await panel()) === "now", await panel());

      /* --- An anchor nobody preventDefault'ed ("fix the sync") does not lose the address ------ */
      await page.evaluate(() => {
        window.__hashes = [];
        addEventListener("hashchange", (e) => window.__hashes.push(new URL(e.newURL).hash));
        showPanel("check");
      });
      await page.click('a[data-act="fixsync"]', { timeout: 30000 });
      await page.waitForFunction(() => window.__hashes.length > 0, null, { timeout: 5000 });
      const seen = await page.evaluate(() => window.__hashes);
      check(`${vp}: the anchor did navigate`, seen.includes("#syncedit"), seen.join(" "));
      check(`${vp}: and the address was put back`, (await hash()) === `#match=${A}`, await hash());
      check(`${vp}: the fold it points at is open`, await page.locator("#syncedit").evaluate((d) => d.open));

      /* --- A link to a match this list does not have is the list, quietly --------------------- */
      await boot(`${base}/#match=1`);
      await page.waitForSelector("#list .card", { state: "attached", timeout: 30000 });
      check(
        `${vp}: an unknown id shows the list, not a failure`,
        (await inList()) && !/Could not open/.test(await page.textContent("#detail")),
      );
      check(`${vp}: and the address stops naming it`, (await hash()) === "", await hash());

      /* --- No link: the boot is what it was --------------------------------------------------- */
      await boot(`${base}/`);
      await page.waitForSelector("#list .card", { state: "attached", timeout: 30000 });
      await page.waitForSelector("#detail .head .id", { state: "attached", timeout: 30000 });
      check(
        `${vp}: no link: the list, the first card painted behind it`,
        (await inList()) && (await hash()) === "",
      );
      check(`${vp}: no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  check("only GETs reached the server", writes.length === 0, writes.map((w) => w.join(" ")).join("; "));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
