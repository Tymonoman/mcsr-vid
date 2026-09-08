// A late /api/export/preview-meta reply for a match the operator has already left must neither
// paint into the current match's panel nor open a progress stream for the old match.
const { chromium } = require("playwright");
(async () => {
  const [base, a, b] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  let progressOpens = 0;
  await page.route(`**/api/export/preview-meta/${a}`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500)); // A's reply lands after B was opened
    await route.fulfill({ json: { exported: false, running: true, percent: 12 } });
  });
  await page.route(`**/api/export/progress/${a}`, async (route) => {
    progressOpens++;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
  });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  progressOpens = 0; // the page auto-selects the first row; only the race below counts
  await page.evaluate((id) => {
    void select(Number(id), { open: true });
  }, a); // not awaited: B must be opened while A is in flight
  await page.waitForTimeout(100);
  await page.evaluate((id) => {
    void select(Number(id), { open: true });
  }, b);
  await page.waitForSelector("#encode", { timeout: 30000 });
  await page.waitForTimeout(2500);
  const html = await page.$eval("#preview", (e) => e.innerHTML);
  const shownId = await page.textContent("#detail .id");
  const paintedA = /encoding…|exportbar(?! hidden)"/.test(html) && html.includes("width:12%");
  console.log("detail shows:", shownId.trim());
  console.log("A's running bar painted into B's panel:", paintedA);
  console.log("progress streams opened for A:", progressOpens);
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(paintedA || progressOpens > 0 || !shownId.includes(b) ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
