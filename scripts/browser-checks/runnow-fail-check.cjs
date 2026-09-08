const { chromium } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.route("**/api/nightly/run", (route) =>
    route.fulfill({ status: 503, json: { error: "disk: 1 match of space left" } }),
  );
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForSelector('#nightly [data-act="nightly-run"]');
  const before = (await page.textContent("#nightly")).replace(/\s+/g, " ").trim();
  await page.click('#nightly [data-act="nightly-run"]');
  await page.waitForTimeout(1200);
  const after = (await page.textContent("#nightly")).replace(/\s+/g, " ").trim();
  const btn = await page.$('#nightly [data-act="nightly-run"]');
  const enabled = btn ? !(await btn.evaluate((b) => b.disabled)) : false;
  console.log("before:", before.slice(0, 140));
  console.log("after: ", after.slice(0, 200));
  console.log("button still there and enabled:", !!btn, enabled);
  // keyboard: Tab to a Rendered row and press Enter
  await page.click("#tab-matches");
  await page.waitForSelector("#list .card");
  await page.focus("#list .card");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const id = await page.$eval("#list .card", (c) => c.dataset.id);
  const shown = (await page.textContent("#detail .id")).trim();
  console.log("keyboard Enter on first row opened:", shown, "(row", id + ")");
  const ring = await page.evaluate(() => {
    const c = document.querySelector("#list .card");
    c.focus();
    return getComputedStyle(c).outlineStyle;
  });
  console.log("focus outline style:", ring);
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  const ok =
    /Run now failed: disk/.test(after) &&
    /Next .*UTC/.test(after) &&
    !!btn &&
    enabled &&
    shown.includes(id) &&
    errors.length === 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
