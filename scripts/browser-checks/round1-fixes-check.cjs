const { chromium } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  await page.goto(base + "/", { waitUntil: "networkidle" });
  // legend text
  const legend = (await page.textContent(".bucketlegend .order")).replace(/\s+/g, " ").trim();
  check("legend names the bucket order", /CLOSE first, then CHAOS/.test(legend), legend);
  // dismiss mid-list: undo line stays in view
  const cards = await page.$$("#suggestions .sugg");
  check("enough cards to dismiss the 7th", cards.length >= 7, String(cards.length));
  const seventh = cards[6];
  await seventh.scrollIntoViewIfNeeded();
  const who = await seventh.$eval(".who, b, .players", (e) => e.textContent).catch(() => "?");
  const y0 = await page.evaluate(() => window.scrollY);
  const dismissBtn = await seventh.$('[data-act="dismiss"], button.dismiss, button:has-text("Dismiss")');
  check("dismiss button on the card", !!dismissBtn);
  await dismissBtn.click();
  await page.waitForSelector("#suggestions .scanline.undo", { timeout: 10000 });
  await page.waitForTimeout(300);
  const undo = await page.$("#suggestions .scanline.undo");
  const box = await undo.boundingBox();
  const y1 = await page.evaluate(() => window.scrollY);
  const pos = await undo.evaluate((e) => getComputedStyle(e).position);
  check(
    "undo line visible in the viewport after a mid-list dismiss",
    box && box.y >= 0 && box.y < 900,
    `top=${box && Math.round(box.y)} scroll ${y0}->${y1} position=${pos}`,
  );
  await page.click('#suggestions .scanline.undo [data-act="undo"]');
  await page.waitForTimeout(1500);
  const after = await page.$$("#suggestions .sugg");
  check("undo restores the card", after.length === cards.length, `${after.length} vs ${cards.length}`);
  // kit position and placeholder guard
  await page.click("#tab-matches");
  await page.evaluate(() => select(13172029, { open: true }));
  await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
  const order = await page.$$eval("#detail h2", (n) => n.map((h) => h.textContent.trim().split(" ")[0]));
  check(
    "Publish kit sits right after Final video",
    order.indexOf("Publish") === order.indexOf("Final") + 1,
    order.join(" > "),
  );
  const kitTop = await page.$eval("#publishkit", (e) => e.getBoundingClientRect().top + window.scrollY);
  const ytTop = await page.$eval("#youtube", (e) => e.getBoundingClientRect().top + window.scrollY);
  check(
    "kit above the YouTube form",
    kitTop < ytTop,
    `kit@${Math.round(kitTop)} youtube@${Math.round(ytTop)}`,
  );
  const counter = await page.$eval("#publishkit .kit .counter", (e) => ({
    t: e.textContent.trim(),
    over: e.classList.contains("over"),
  }));
  const title = await page.$eval("#publishkit .kit textarea", (t) => t.value);
  check(
    "placeholder title is flagged, not counted",
    title.includes("<HOOK>") ? counter.over && /pick a hook/.test(counter.t) : true,
    `${counter.t} over=${counter.over} | ${title.slice(0, 40)}`,
  );
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
