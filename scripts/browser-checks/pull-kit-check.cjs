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
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
    const labels = await page.$$eval("#publishkit .kitlabel", (n) => n.map((e) => e.textContent.trim()));
    console.log("kit blocks:", labels.join(" | "));
    const kit = await page.$(`#publishkit .kit:has(.kitlabel:text-is("Pull this match to your PC"))`);
    const text = await kit.$eval("textarea", (t) => t.value);
    await kit.$eval("button.copy", (b) => b.click());
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log("pull cmd:", text.slice(0, 160));
    console.log("copied ok:", clip === text);
    await page.waitForSelector("#preview a[href*='/api/export/bundle/']", { timeout: 20000 });
    const bundle = await page.$eval(
      "#preview a[href*='/api/export/bundle/']",
      (a) => a.textContent.trim() + " -> " + a.getAttribute("href"),
    );
    console.log("bundle link:", bundle);
    console.log("errors:", errors.length ? errors : "none");
    process.exitCode =
      labels.includes("Pull this match to your PC") &&
      clip === text &&
      /^mkdir -p .* && rsync -av/.test(text) &&
      bundle.includes(`/api/export/bundle/${id}`) &&
      errors.length === 0
        ? 0
        : 1;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
