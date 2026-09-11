const { launchFor } = require("./launch.cjs");

/* A failure has to report next to the control that caused it.
   #failure sits near the top of the match pane, above the hook, the title editor, the preview, the
   sync editor, the publish kit, the Short and the YouTube panel — so a press at the bottom of that
   column used to report itself a screen and a half away, often off-screen entirely. This drives
   two real refusals (both rejected by the server before anything is written) and checks where the
   message lands, that a retry replaces it rather than stacking, and that dismiss removes it. */
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await launchFor(base);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const bannerLit = () =>
    page.evaluate(() => document.querySelector("#failure")?.classList.contains("live") ?? false);

  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });

    // --- Settings: an out-of-range value, forced past the input's own max attribute -------------
    await page.click("#tab-settings");
    await page.waitForSelector("#setsave", { timeout: 20000 });
    await page.evaluate(() => {
      document.querySelector('#settings [data-key="nightlyMaxRenders"]').value = "99";
    });
    await page.click("#setsave");
    await page.waitForSelector("#settings .inlinefail", { timeout: 15000 });
    check("a refused save reports inside the settings panel", true);
    check(
      "with the server's own reason",
      /between 1 and 4/.test(await page.locator("#settings .inlinefail pre").innerText()),
    );
    check("and not only in the banner at the top", (await bannerLit()) === false);

    const gap = await page.evaluate(() => {
      const box = document.querySelector("#settings .inlinefail");
      const btn = document.querySelector("#setsave");
      return Math.round(box.getBoundingClientRect().top - btn.getBoundingClientRect().bottom);
    });
    check("immediately under the button that failed", gap >= 0 && gap < 80, `${gap}px`);

    // Pressing again must replace the stale message, not stack a second one under it.
    await page.click("#setsave");
    await page.waitForTimeout(1200);
    check("a retry replaces rather than stacks", (await page.locator("#settings .inlinefail").count()) === 1);

    await page.locator("#settings .inlinefail .dismiss").click();
    await page.waitForTimeout(200);
    check("dismiss removes it", (await page.locator("#settings .inlinefail").count()) === 0);

    // --- Adopt: a malformed video id, refused before any API call -------------------------------
    const uploads = await (await page.request.get(base + "/api/youtube/uploads")).json();
    const paired = new Set((uploads.uploads ?? []).map((u) => u.matchId));
    const matches = await (await page.request.get(base + "/api/matches")).json();
    const free = (matches.matches ?? []).find((m) => !paired.has(m.matchId) && !m.hidden);
    if (!free) {
      console.log("PASS adopt -- every match on the shelf is already on the channel, nothing to drive");
    } else {
      await page.goto(base + "/", { waitUntil: "networkidle" });
      await page.evaluate((id) => select(Number(id), { open: true }), free.matchId);
      await page.waitForSelector("#ytAdoptId", { timeout: 30000 });
      await page.fill("#ytAdoptId", "not-an-id");
      await page.click("#ytAdopt");
      await page.waitForSelector("#youtube .inlinefail", { timeout: 15000 });
      check(
        "a refused adopt reports inside the YouTube panel",
        /not a YouTube video id/.test(await page.locator("#youtube .inlinefail pre").innerText()),
      );
      check("and not only in the banner at the top", (await bannerLit()) === false);
    }

    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
