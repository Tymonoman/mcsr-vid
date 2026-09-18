const { devices } = require("playwright");
const { launchFor } = require("./launch.cjs");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await launchFor(base);
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
    // (3) phone: the section bar's four links exist, and Publish shows its heading (YouTube, the
    // first thing in that group) on the first screen with the head -- match id, #headwarn --
    // still above it: the tap scrolls to the top, not to the heading, so the sync-stale mirror
    // is on the panel that holds Upload
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    p = await ctx.newPage();
    errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base + "/", { waitUntil: "networkidle" });
    await p.click("#tab-matches");
    await p.evaluate(() => select(13172029, { open: true }));
    await p.waitForSelector("#detail .jump a", { timeout: 30000 });
    // Attached, not visible: the kit is in the Publish group, which the phone shows only once
    // its bar link is tapped -- the tap below.
    await p.waitForSelector("#publishkit .kit", { state: "attached", timeout: 30000 });
    const links = await p.$$eval("#detail .jump a", (n) =>
      n.map((a) => a.textContent.trim() + "→" + a.getAttribute("href")),
    );
    await p.click('#detail .jump a[href="#h-youtube"]');
    await p.waitForTimeout(600);
    const y = await p.$eval("#h-youtube", (h) => Math.round(h.getBoundingClientRect().top));
    const barH = await p
      .$eval("#backtolist", (b) => Math.round(b.getBoundingClientRect().height))
      .catch(() => 0);
    const vis = await p.$eval("#h-youtube", (h) => h.checkVisibility());
    const scrollY = await p.evaluate(() => window.scrollY);
    const headwarnVis = await p.$eval(
      "#headwarn",
      (h) => h.checkVisibility() && h.getBoundingClientRect().top >= 0,
    );
    check("phone section bar has the four groups", links.length === 4, links.join(" "));
    check(
      "Publish opens at the top with the YouTube heading on the first screen",
      vis && scrollY === 0 && y >= barH && y < 400,
      `heading top ${y}px, back bar ${barH}px, scrollY ${scrollY}`,
    );
    check("#headwarn is on screen on Publish", headwarnVis, String(headwarnVis));
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
