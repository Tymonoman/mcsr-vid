const { chromium } = require("playwright");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  try {
    // matching hook: no line
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#short .moment", { timeout: 30000 });
    check("no mismatch line when the Short matches the thumbnail", !(await page.$("#short .scanline.bad")));
    // the thumbnail moved on (mocked): the line appears and re-cut starts a render
    let started = false;
    await page.route(`**/api/shorts/moments/${id}`, async (r) => {
      const d = await (await r.fetch()).json();
      return r.fulfill({ json: { ...d, hook: "Rematch: Infume leads 3-2" } });
    });
    await page.route(`**/api/shorts/render/${id}`, (r) => {
      started = true;
      return r.fulfill({ status: 202, json: { started: true, pick: 0 } });
    });
    await page.route(`**/api/shorts/progress/${id}`, (r) =>
      r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
    );
    await page.evaluate((id) => loadShort(Number(id)), id);
    await page.waitForSelector("#short .scanline.bad", { timeout: 10000 });
    const line = (await page.textContent("#short .scanline.bad")).replace(/\s+/g, " ").trim();
    check(
      "mismatch line names both headlines",
      /The Short still says .*; the thumbnail now says .Rematch: Infume leads 3-2/.test(line),
      line,
    );
    await page.click('#short [data-act="recut"]');
    await page.waitForTimeout(500);
    check("re-cut starts a Short render", started);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
