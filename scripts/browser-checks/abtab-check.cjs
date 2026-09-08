const { chromium } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click("#tab-abtest");
  await page.waitForTimeout(4000);
  const text = (await page.textContent("#abtest, #panel-abtest, main")).replace(/\s+/g, " ");
  const nothing = /Nothing uploaded yet/.test(text);
  const rows = await page.$$eval("table tbody tr", (n) =>
    n.map((r) => r.textContent.replace(/\s+/g, " ").trim()),
  );
  console.log("says nothing uploaded:", nothing);
  console.log("table rows:", rows.slice(0, 6));

  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(!nothing && rows.length > 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
