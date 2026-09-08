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
  try {
    // last-registered route matches first: the generic one goes in before the rescan one
    await page.route("**/api/suggestions/*", (r) =>
      r.request().method() === "DELETE"
        ? r.fulfill({ status: 500, json: { error: "cache write failed" } })
        : r.continue(),
    );
    await page.route("**/api/suggestions/rescan", (r) =>
      r.fulfill({ status: 503, json: { error: "MCSR API rate limited" } }),
    );
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.click('[data-act="rescan"]');
    await page.waitForTimeout(500);
    const scan = (await page.textContent("#suggestions .scanline:not(.undo)")).replace(/\s+/g, " ");
    check(
      "rescan failure shown in the scan line",
      /rescan failed: MCSR API rate limited/.test(scan),
      scan.slice(0, 120),
    );
    check("rescan link still there", !!(await page.$('[data-act="rescan"]')));
    const n0 = (await page.$$("#suggestions .sugg")).length;
    await page.click('#suggestions .sugg [data-act="dismiss"]');
    await page.waitForTimeout(500);
    const acts = (await page.textContent("#suggestions .sugg .acts")).replace(/\s+/g, " ");
    const n1 = (await page.$$("#suggestions .sugg")).length;
    check(
      "dismiss failure shown on the card, card kept",
      /dismiss failed: cache write failed/.test(acts) && n0 === n1,
      `${acts.slice(0, 100)} | ${n0}->${n1}`,
    );
    check("no unhandled page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
