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
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.evaluate((id) => select(Number(id), { open: true }), id);
  await page.waitForSelector("#publishkit .kit", { timeout: 20000 });
  const labels = await page.$$eval("#publishkit .kitlabel", (n) => n.map((e) => e.textContent.trim()));
  console.log("blocks:", labels.join(" | "));
  const kit = await page.$(`#publishkit .kit:has(.kitlabel:text-is("Pinned comment"))`);
  if (!kit) {
    console.log("FAIL: no Pinned comment block");
    process.exit(1);
  }
  const text = await kit.$eval("textarea", (t) => t.value);
  console.log("text:", text);
  await kit.$eval("button.copy", (b) => b.click());
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  console.log(
    "clipboard matches:",
    clip === text,
    "| copy button says:",
    await kit.$eval("button.copy", (b) => b.textContent.trim()),
  );
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(clip === text && /vs .* split for split/.test(text) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
