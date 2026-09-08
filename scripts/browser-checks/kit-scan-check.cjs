// The kit's community post block, and a failed scan that offers a retry which repaints the list.
const { chromium } = require("playwright");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  try {
    // 1. a scan that failed, then "try again" answered with a real list
    let real = null;
    await page.route("**/api/suggestions", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      if (!real) {
        const r = await route.fetch();
        real = await r.json();
        return route.fulfill({ json: { ...real, suggestions: [], error: "MCSR API: 503", scanning: false } });
      }
      return route.fulfill({ json: real });
    });
    await page.route("**/api/suggestions/rescan", (route) => route.fulfill({ status: 202, json: real }));
    await page.goto(base + "/", { waitUntil: "networkidle" });
    const line = (await page.textContent("#suggestions .scanline.bad")).replace(/\s+/g, " ").trim();
    check(
      "failed scan shows the error and a retry",
      /scan failed: MCSR API: 503 .* try again/.test(line),
      line,
    );
    await page.click('#suggestions .scanline.bad [data-act="rescan"]');
    await page.waitForSelector("#suggestions .sugg", { timeout: 10000 });
    const n = (await page.$$("#suggestions .sugg")).length;
    check("try again repaints the list", n > 0, `${n} cards`);
    const tip = await page.$eval('#suggestions [data-act="rescan"]', (a) => a.title);
    check(
      "rescan tooltip says the real cadence",
      /every \d+ minutes/.test(tip) && !/refreshes itself/.test(tip),
      tip,
    );
    // 2. the kit's community post
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
    const labels = await page.$$eval("#publishkit .kitlabel", (n) => n.map((e) => e.textContent.trim()));
    check(
      "Community post block present, after Pinned comment",
      labels.indexOf("Community post") === labels.indexOf("Pinned comment") + 1,
      labels.join(" | "),
    );
    const kit = await page.$(`#publishkit .kit:has(.kitlabel:text-is("Community post"))`);
    const text = await kit.$eval("textarea", (t) => t.value);
    await kit.$eval("button.copy", (b) => b.click());
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(
      "community post carries the title and copies",
      /^New: .* vs .*Who did you have/.test(text) && clip === text,
      text.slice(0, 140),
    );
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
