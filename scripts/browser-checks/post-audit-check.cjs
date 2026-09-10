const { chromium } = require("playwright");

/* The upload form is dead code until the YouTube compliance audit clears and `uploadsEnabled`
   flips true — which is exactly when a mistake in it would first be seen, on the live channel,
   by the operator. This renders that branch today by answering /api/youtube/status with the
   flag on, for a match that is on the channel and one that is not. Nothing is uploaded: the
   flag is flipped in the browser's copy of the response, never on the server. */
(async () => {
  const [base, ready, published] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };

  try {
    await page.route("**/api/youtube/status", async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      await route.fulfill({ response: res, json: { ...data, uploadsEnabled: true } });
    });
    await page.goto(base + "/", { waitUntil: "networkidle" });

    // A match not on the channel: the upload form itself, which nothing has ever rendered.
    await page.evaluate((id) => select(Number(id), { open: true }), ready);
    await page.waitForSelector("#youtube #ytUpload", { timeout: 30000 });
    check("the upload form renders with uploads enabled", true);
    check("it offers the three visibility choices", (await page.locator("#ytPrivacy option").count()) === 3);
    check("and a publish slot", (await page.locator("#ytWhen").count()) === 1);
    check("no page errors rendering it", errors.length === 0, errors.join(" | "));

    // A match already on the channel keeps the finished-steps view, flag or no flag, and the two
    // repairs that button makes are stated next to it rather than in the form above.
    if (published) {
      errors.length = 0;
      await page.evaluate((id) => select(Number(id), { open: true }), published);
      await page.waitForSelector("#youtube #ytFinish", { timeout: 30000 });
      const text = await page.locator("#youtube").innerText();
      check("a published video still shows its finished steps", /thumbnail.*playlists.*comment.*tags/s.test(text));
      check("no upload form on a published video", (await page.locator("#ytUpload").count()) === 0);
      check("no page errors on the published branch", errors.length === 0, errors.join(" | "));
    }
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
