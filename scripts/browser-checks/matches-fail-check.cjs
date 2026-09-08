const { chromium } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.route("**/api/matches", (route) =>
    route.fulfill({ status: 500, json: { error: "media dir unreadable" } }),
  );
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const list = (await page.textContent("#list")).replace(/\s+/g, " ").trim();
  const sugg = (await page.textContent("#suggestions")).replace(/\s+/g, " ").trim();
  const nightly = (await page.textContent("#nightly")).replace(/\s+/g, " ").trim();
  console.log("list:", list.slice(0, 120));
  console.log("suggestions:", sugg.slice(0, 100));
  console.log("nightly:", nightly.slice(0, 80));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(
    /Could not load matches: media dir unreadable/.test(list) && !/loading…/.test(sugg) && sugg.length > 40
      ? 0
      : 1,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
