// A match uploaded through Studio (no youtube.json) must show as published everywhere the
// dashboard says so: the Rendered row, the YouTube panel (with stats), the kit's DM link.
const { chromium } = require("playwright");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("/api/thumbnail/")) errors.push("console: " + m.text());
  });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click("#tab-matches");
  const row = await page.$(`#list .card[data-id="${id}"]`);
  const rowText = row ? (await row.textContent()).replace(/\s+/g, " ").trim() : "(no row)";
  console.log("row:", rowText.slice(0, 160));
  const tab = await page.textContent("#tab-matches");
  console.log("tab label:", tab.trim());
  await page.evaluate((id) => select(Number(id), { open: true }), id);
  await page.waitForSelector("#youtube .published, #youtube .upload", { timeout: 30000 });
  const yt = (await page.textContent("#youtube")).replace(/\s+/g, " ").trim();
  console.log("youtube panel:", yt.slice(0, 220));
  await page.waitForSelector("#publishkit .kit", { timeout: 20000 });
  const dm = await page.$$eval("#publishkit .kit", (n) =>
    n.map((k) => k.querySelector("textarea").value).find((v) => v.startsWith("Hey ")),
  );
  console.log("dm:", dm.slice(0, 150));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  const ok =
    /published/.test(rowText) &&
    /found on the channel/.test(yt) &&
    /views/.test(yt) &&
    /youtu\.be\//.test(dm);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
