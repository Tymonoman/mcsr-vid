const { chromium, devices } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  try {
    // (1) newest match published → the auto-opened match is the top card in display order
    let p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.route("**/api/matches", async (r) => {
      const d = await (await r.fetch()).json();
      d.matches[0].uploaded = true;
      return r.fulfill({ json: d });
    });
    await p.goto(base + "/", { waitUntil: "networkidle" });
    await p.click("#tab-matches");
    const top = await p.$eval("#list .card", (c) => c.dataset.id);
    const sel = await p.$eval('#list .card[aria-selected="true"]', (c) => c.dataset.id).catch(() => null);
    const shown = (await p.textContent("#detail .id")).trim();
    check(
      "auto-opened match is the top card",
      top === sel && shown.includes(top),
      `top ${top} selected ${sel} detail ${shown.slice(0, 40)}`,
    );
    // (2) a failed scan keeps the list's age
    await p.route("**/api/suggestions", async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const d = await (await r.fetch()).json();
      return r.fulfill({ json: { ...d, scanning: false, error: "MCSR API 429: rate limited" } });
    });
    await p.reload({ waitUntil: "networkidle" });
    const line = (await p.textContent("#suggestions .scanline.bad")).replace(/\s+/g, " ").trim();
    check(
      "failed scan line keeps the age",
      /^list from \d+[mhd] ago · scan failed: MCSR API 429/.test(line),
      line,
    );
    check("no page errors (desktop)", errors.length === 0, errors.join(" | "));
    await p.close();
    // (3) phone: jump links exist and land the heading under the back bar
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    p = await ctx.newPage();
    errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base + "/", { waitUntil: "networkidle" });
    await p.click("#tab-matches");
    await p.evaluate(() => select(13172029, { open: true }));
    await p.waitForSelector("#detail .jump a", { timeout: 30000 });
    await p.waitForSelector("#publishkit .kit", { timeout: 30000 });
    const links = await p.$$eval("#detail .jump a", (n) =>
      n.map((a) => a.textContent.trim() + "→" + a.getAttribute("href")),
    );
    await p.click('#detail .jump a[href="#h-publishkit"]');
    await p.waitForTimeout(600);
    const y = await p.$eval("#h-publishkit", (h) => Math.round(h.getBoundingClientRect().top));
    const barH = await p
      .$eval("#backtolist", (b) => Math.round(b.getBoundingClientRect().height))
      .catch(() => 0);
    const vis = await p.$eval("#h-publishkit", (h) => h.checkVisibility());
    check("phone jump links present", links.length === 3, links.join(" "));
    check(
      "Publish kit heading lands under the back bar",
      vis && y >= barH && y < 200,
      `heading top ${y}px, back bar ${barH}px`,
    );
    const deskJump = await (async () => {
      const d = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await d.goto(base + "/", { waitUntil: "networkidle" });
      await d.evaluate(() => select(13172029, { open: true }));
      await d.waitForSelector("#detail .jump", { state: "attached" });
      const v = await d.$eval("#detail .jump", (e) => getComputedStyle(e).display);
      await d.close();
      return v;
    })();
    check("jump links hidden on desktop", deskJump === "none", deskJump);
    check("no page errors (phone)", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
