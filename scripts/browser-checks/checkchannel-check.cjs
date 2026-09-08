// "Uploaded it in Studio already? check the channel": a forced listing that finds the match
// flips the panel, the row and the kit; one that does not says so and leaves the form.
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
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector('#youtube [data-act="checkchannel"]', { timeout: 30000 });
    // (a) the real call: not on the channel → the link says so, the form stays
    await page.click('#youtube [data-act="checkchannel"]');
    await page.waitForFunction(
      () =>
        !/checking…/.test(document.querySelector('#youtube [data-act="checkchannel"]')?.textContent || "x"),
      { timeout: 30000 },
    );
    const linkText = (await page.textContent('#youtube [data-act="checkchannel"]')).trim();
    check(
      "a real check that finds nothing says so and keeps the form",
      /not on the channel yet/.test(linkText) && !!(await page.$("#ytUpload")),
      linkText,
    );
    // (b) the channel now has it (mocked): panel, row and kit flip
    let fresh = 0;
    const found = {
      matchId: Number(id),
      videoId: "MOCKVID0001",
      title: "mock",
      publishedAt: "2026-09-08T09:00:00Z",
      privacyStatus: "public",
      source: "channel",
      stats: { views: 12, likes: 1, comments: 0 },
    };
    await page.route("**/api/youtube/uploads*", async (r) => {
      if (r.request().url().includes("fresh=1")) fresh++;
      const d = await (await r.fetch()).json();
      d.uploads.push(found);
      return r.fulfill({ json: d });
    });
    // the kit's link comes from the server's own pairing, which a browser-side mock cannot feed
    await page.route(`**/api/publishkit/${id}`, async (r) => {
      const d = await (await r.fetch()).json();
      d.videoUrl = "https://youtu.be/MOCKVID0001";
      return r.fulfill({ json: d });
    });
    await page.route("**/api/matches", async (r) => {
      const d = await (await r.fetch()).json();
      for (const m of d.matches) if (m.matchId === Number(id)) m.uploaded = true;
      return r.fulfill({ json: d });
    });
    const reqs = [];
    page.on("request", (r) => {
      if (/api\/(matches|youtube\/uploads)/.test(r.url()))
        reqs.push(r.method() + " " + r.url().replace(/^http:\/\/[^/]+/, ""));
    });
    await page.click('#youtube [data-act="checkchannel"]');
    await page.waitForTimeout(4000);
    console.log("requests:", reqs.join(" | "));
    console.log(
      "row now:",
      (
        await page
          .$eval(`#list .card[data-id="${id}"]`, (c) => c.textContent.replace(/\s+/g, " ").trim())
          .catch(() => "(no row)")
      ).slice(0, 80),
    );
    console.log(
      "link now:",
      (await page.textContent('#youtube [data-act="checkchannel"]').catch(() => "(gone)")).trim(),
    );
    await page.waitForSelector("#youtube .published", { timeout: 20000 });
    const panel = (await page.textContent("#youtube")).replace(/\s+/g, " ");
    await page.waitForFunction(
      (id) => /published/.test(document.querySelector(`#list .card[data-id="${id}"]`)?.textContent || ""),
      id,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () => /youtu\.be\/MOCKVID0001/.test(document.querySelector("#publishkit")?.textContent || ""),
      { timeout: 10000 },
    );
    check(
      "forced listing hit once and the panel flipped to published",
      fresh === 1 && /found on the channel/.test(panel) && /12 views/.test(panel),
      panel.slice(0, 120),
    );
    check("row says published and the kit's DM carries the link", true);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
