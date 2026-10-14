const { launchFor } = require("./launch.cjs");
(async () => {
  const [base, given] = process.argv.slice(2);
  // An exported match: the Sync check below paints only when there is an export to check. The
  // id it used to name (13172029) was archived off the disk.
  const id =
    Number(given) ||
    (await (await fetch(`${base}/api/matches`)).json()).matches.find((m) => m.exported && !m.hidden)?.matchId;
  const browser = await launchFor(base);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  await page.goto(base + "/", { waitUntil: "networkidle" });
  // dismiss mid-list: undo line stays in view
  // Direct children only: the playoffs section paints its bracket slots as `.sugg` cards too,
  // nested in #playoffs, and those carry no Dismiss. Same rule app.js binds its handlers with.
  const cards = await page.$$("#suggestions > .sugg");
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
  const after = await page.$$("#suggestions > .sugg");
  check("undo restores the card", after.length === cards.length, `${after.length} vs ${cards.length}`);
  // section order and placeholder guard: the Check group leads with the video, the sync
  // frames right under it, and the Publish group leads with YouTube, the kit under it
  await page.click("#tab-matches");
  await page.evaluate((id) => select(id, { open: true }), id);
  await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
  await page.waitForSelector("#synccheck h2", { timeout: 30000 });
  const order = await page.$$eval("#detail h2", (n) => n.map((h) => h.textContent.trim().split(" ")[0]));
  check(
    "Sync check sits right after Final video",
    order.indexOf("Sync") === order.indexOf("Final") + 1,
    order.join(" > "),
  );
  const kitTop = await page.$eval("#publishkit", (e) => e.getBoundingClientRect().top + window.scrollY);
  const ytTop = await page.$eval("#youtube", (e) => e.getBoundingClientRect().top + window.scrollY);
  check(
    "YouTube form above the kit",
    ytTop < kitTop,
    `youtube@${Math.round(ytTop)} kit@${Math.round(kitTop)}`,
  );
  // The Title block by its label: the kit's first block is the pull command now, and reading that
  // made this pass on any title, <HOOK> or not.
  const titleKit = '#publishkit .kit:has(.kitlabel:text-is("Title"))';
  const counter = await page.$eval(`${titleKit} .counter`, (e) => ({
    t: e.textContent.trim(),
    over: e.classList.contains("over"),
  }));
  const title = await page.$eval(`${titleKit} textarea`, (t) => t.value);
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
