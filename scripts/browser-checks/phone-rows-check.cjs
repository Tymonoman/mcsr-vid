const { chromium, devices } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click("#tab-matches");
  await page.waitForSelector("#list .card");
  const visible = await page.$$eval(
    "#list .card .rowacts",
    (n) => n.filter((e) => getComputedStyle(e).display !== "none").length,
  );
  const rows = await page.$$eval("#list .card", (n) => n.length);
  console.log(`phone: ${rows} rows, ${visible} with visible Hide/Delete`);
  // tapping the row's lower-right corner (where Delete sat) must open the match, not arm a delete
  const box = await (await page.$("#list .card")).boundingBox();
  await page.touchscreen.tap(box.x + box.width - 30, box.y + box.height - 12);
  await page.waitForTimeout(600);
  const detailShown = await page.$eval(
    "#detail",
    (e) => getComputedStyle(e).display !== "none" && e.textContent.trim().length > 0,
  );
  const armed = await page.$$eval('#list .card .del[data-armed="1"]', (n) => n.length);
  console.log(`tap on the corner: detail shown=${detailShown}, deletes armed=${armed}`);
  await ctx.close();
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desk.goto(base + "/", { waitUntil: "networkidle" });
  await desk.click("#tab-matches");
  await desk.waitForSelector("#list .card");
  const deskVisible = await desk.$$eval(
    "#list .card .rowacts",
    (n) => n.filter((e) => getComputedStyle(e).display !== "none").length,
  );
  console.log(`desktop: ${deskVisible} rows with visible Hide/Delete`);
  await browser.close();
  process.exit(visible === 0 && armed === 0 && detailShown && deskVisible > 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
