const { launchFor } = require("./launch.cjs");

/* "Re-render thumbnails" and the swap on YouTube, pressed the way the operator does.
   Usage: node thumbs-rerender-check.cjs <base> <uploaded match id> [screenshot dir]

   The re-render is REAL: it draws the match's variants into thumbnail-new/ on the server -- run it
   against a test server on a scratch copy of the media, not the lab.
   The swap is NOT: POST /api/thumbnails/:id/youtube is answered in the browser, and the GET is
   patched to say YouTube is connected, so no thumbnails.set can reach the live channel. What it
   pins there is the button, what it sends and the line it leaves. */
(async () => {
  const [base, id, shots] = process.argv.slice(2);
  const browser = await launchFor(base);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const errors = [];
  const bytes = (page, path) => page.request.get(base + path).then((r) => r.body());
  const panel = (page) => page.request.get(`${base}/api/thumbnails/${id}`).then((r) => r.json());
  const shoot = (page, name) =>
    shots && page.locator('section[data-panel="package"]').screenshot({ path: `${shots}/${name}.png` });
  // The swap, answered here: `sent` records what the page sent; the GET says what YouTube wears.
  const sent = [];
  let set = null;
  const stubYouTube = async (page) => {
    await page.route(new RegExp(`/api/thumbnails/${id}$`), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const real = await (await route.fetch()).json();
      if (real.youtube) Object.assign(real.youtube, { connected: true, set, canUndo: set !== null });
      await route.fulfill({ json: real });
    });
    await page.route(new RegExp(`/api/thumbnails/${id}/youtube$`), async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      sent.push(body);
      const at = new Date().toISOString();
      set = body.undo ? { variant: null, at } : { variant: body.variant, at, from: "thumbnail-new" };
      await route.fulfill({ json: { videoId: "stubbed0000", title: "Stubbed title", set } });
    });
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await stubYouTube(page);
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((m) => select(Number(m), { open: true }), id);
    await page.waitForSelector("#thumbrerender", { timeout: 20000 });
    await page.locator("#h-thumbs").scrollIntoViewIfNeeded();

    const before = await panel(page);
    check("an uploaded match re-renders beside its live set", before.onChannel === true);
    const key = before.variants[0].key;
    const oldVariant = await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}`);
    const oldLive = await bytes(page, `/api/thumbnail/${id}`);
    check(
      "the line says YouTube is not changed by it",
      /nothing on YouTube changes|YouTube are unchanged/.test(await page.locator("#thumbmsg").innerText()),
    );

    await page.click("#thumbrerender");
    let onStrip = false;
    for (let i = 0; i < 20 && !onStrip; i++) {
      const n = await page.request.get(base + "/api/nightly").then((r) => r.json());
      onStrip = (n.activity?.running ?? []).some((r) => r.step === "thumbnails" && r.matchId === Number(id));
      if (!onStrip) await page.waitForTimeout(250);
    }
    check("the strip's activity line carries the re-render", onStrip);
    // This run's job, not one an earlier run left in the server's table: settled on the server, then
    // painted in the panel (it polls every 3 s while one runs).
    let after = before;
    for (let i = 0; i < 480 && !(after.job?.since !== before.job?.since && !after.job?.running); i++) {
      await page.waitForTimeout(500);
      after = await panel(page);
    }
    await page.waitForFunction(
      (since) => (document.querySelector("#variants img")?.getAttribute("src") ?? "").endsWith(since),
      encodeURIComponent(after.job.since),
      { timeout: 20000 },
    );
    const msg = await page.locator("#thumbmsg").innerText();
    check(
      "the re-render finished",
      /re-rendered.*the live thumbnail and YouTube are unchanged/.test(msg),
      msg,
    );
    check(
      "the live variants, manifest and thumbnail.png are untouched",
      (await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}`)).equals(oldVariant) &&
        (await bytes(page, `/api/thumbnail/${id}`)).equals(oldLive) &&
        JSON.stringify([after.variants, after.chosen, after.chosenBy]) ===
          JSON.stringify([before.variants, before.chosen, before.chosenBy]),
    );
    const newKeys = (after.newVariants ?? []).map((v) => v.key);
    const newImage = await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}&new=1`);
    check(
      "a new set in today's design beside the old one",
      newKeys.length === 4 && newImage.length > 5000 && !newImage.equals(oldVariant),
      newKeys.join(","),
    );
    const tiles = page.locator("#variants .variant:has(.ytput)");
    check(
      "the new tiles are in the panel, each with Put on YouTube",
      (await tiles.count()) === newKeys.length,
    );
    const src = await tiles.first().locator("img").getAttribute("src");
    check("the panel asks for the new stills, not cached ones", src.includes("&new=1&r="), src);
    // Test & Compare needs the old and the new image as files.
    const links = await page.$$eval("#variants a[download]", (as) => as.map((a) => a.getAttribute("href")));
    check(
      "download links: the current thumbnail and one per new tile",
      links.includes(`/api/thumbnail/${id}`) &&
        links.filter((h) => h.includes("&new=1")).length === newKeys.length,
      links.join(" "),
    );
    await shoot(page, "desktop-after-rerender");

    const says = await page.locator("#thumbytmsg").innerText();
    check(
      "Put on YouTube says what it replaces",
      /replaces the thumbnail on “.+” with that tile/.test(says),
      says,
    );
    const putKey = await tiles.nth(1).getAttribute("data-key");
    await tiles.nth(1).locator(".ytput").click();
    await page.waitForFunction(() =>
      /YouTube accepted it/.test(document.querySelector("#thumbytmsg")?.textContent),
    );
    const accepted = await page.locator("#thumbytmsg").innerText();
    check("it sent the tile pressed", JSON.stringify(sent) === JSON.stringify([{ variant: putKey }]));
    check(
      "the line names that tile and what YouTube answered",
      accepted.includes(`now wears ${putKey}, new design`) && /Stubbed title/.test(accepted),
      accepted,
    );
    check("Undo is offered after a put", (await page.locator("#thumbundo").count()) === 1);
    await shoot(page, "desktop-after-put");
    await page.click("#thumbundo");
    await page.waitForFunction(() =>
      /the image it had before/.test(document.querySelector("#thumbytmsg")?.textContent),
    );
    check("Undo sends undo", JSON.stringify(sent.at(-1)) === JSON.stringify({ undo: true }));

    // The bulk: a Settings row, render only.
    await page.click("#tab-settings");
    await page.waitForSelector("#thumbsall");
    check(
      "Settings offers the bulk re-render, and says nothing changes on YouTube",
      /every uploaded video/.test(await page.locator("#thumbsall").innerText()) &&
        /nothing changes on YouTube/.test(
          await page.locator("#thumbsall").locator("xpath=../..").innerText(),
        ),
    );

    // The phone: the Package group on its own.
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    phone.on("pageerror", (e) => errors.push(e.message));
    set = null;
    await stubYouTube(phone);
    await phone.goto(base + "/", { waitUntil: "networkidle" });
    await phone.evaluate((m) => select(Number(m), { open: true }), id);
    await phone.click('.jump [data-panel="package"]');
    await phone.waitForSelector("#variants .ytput");
    const target = async (sel) => (await phone.locator(sel).first().boundingBox())?.height >= 44;
    check(
      "the phone's Re-render and Put are 44 px targets",
      (await target("#thumbrerender")) && (await target("#variants .ytput")),
    );
    check(
      "no sideways scroll on the phone",
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    );
    if (shots) {
      await phone.screenshot({ path: `${shots}/phone-package.png` });
      await phone.evaluate(() =>
        document.querySelector("#variants .ytput").scrollIntoView({ block: "center" }),
      );
      await phone.screenshot({ path: `${shots}/phone-new-set.png` });
    }

    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("ran to the end", false, e.message);
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})();
