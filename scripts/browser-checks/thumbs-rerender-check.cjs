const { launchFor } = require("./launch.cjs");

/* "Re-render thumbnails", Use this on a new tile and the swap on YouTube, pressed the way the
   operator does.
   Usage: node thumbs-rerender-check.cjs <base> <match on the channel> <match not on it> [screenshot dir]

   The re-renders and Use this are REAL: they draw into thumbnail-new/ on the server and move the
   new set over the live one -- run it against a test server on a scratch copy of the media, not
   the lab. The swap is NOT: POST /api/thumbnails/:id/youtube is answered in the browser, and the GET
   is patched to say YouTube is connected, so no thumbnails.set can reach the live channel. */
(async () => {
  const [base, id, offId, shots] = process.argv.slice(2);
  const browser = await launchFor(base);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const errors = [];
  const bytes = (page, path) => page.request.get(base + path).then((r) => r.body());
  const panel = (page, m = id) => page.request.get(`${base}/api/thumbnails/${m}`).then((r) => r.json());
  const shoot = (page, name) =>
    shots && page.locator('section[data-panel="package"]').screenshot({ path: `${shots}/${name}.png` });
  // Every live file the upload, Finish and the A/B tab read, as bytes: the variants and thumbnail.png.
  const liveFiles = async (page, m) => {
    const p = await panel(page, m);
    const files = [await bytes(page, `/api/thumbnail/${m}`)];
    for (const v of p.variants)
      files.push(await bytes(page, `/api/thumbnail/${m}?v=${encodeURIComponent(v.key)}`));
    return { files, manifest: JSON.stringify([p.variants, p.chosen, p.chosenBy]) };
  };
  const same = (a, b) => a.manifest === b.manifest && a.files.every((f, i) => f.equals(b.files[i]));
  // Press Re-render and wait for this run's job to settle on the server and in the panel.
  const rerender = async (page, m, during = async () => {}) => {
    const before = await panel(page, m);
    await page.click("#thumbrerender");
    await page.waitForSelector("#thumbrerender[disabled]");
    await during();
    let after = before;
    for (let i = 0; i < 480 && !(after.job?.since !== before.job?.since && !after.job?.running); i++) {
      await page.waitForTimeout(500);
      after = await panel(page, m);
    }
    await page.waitForSelector("#thumbrerender:not([disabled])", { timeout: 20000 });
    return after;
  };
  const open = async (page, m) => {
    await page.evaluate((x) => select(Number(x), { open: true }), m);
    await page.waitForSelector("#thumbrerender", { timeout: 20000 });
    await page.locator("#h-thumbs").scrollIntoViewIfNeeded();
  };
  // The swap, answered here: `sent` records what the page sent; the GET says what YouTube wears.
  const sent = [];
  let set = null;
  let patch = null;
  const stubYouTube = async (page) => {
    await page.route(/\/api\/thumbnails\/\d+$/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const real = await (await route.fetch()).json();
      if (real.youtube) Object.assign(real.youtube, { connected: true, set, canUndo: set !== null });
      await route.fulfill({ json: patch ? patch(real) : real });
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

    /* --- On the channel: the new set beside the live one, Put and Undo -------------------------- */
    await open(page, id);
    const before = await panel(page);
    check("the match is on the channel", before.onChannel === true);
    const liveBefore = await liveFiles(page, id);
    check(
      "the line says neither the live thumbnail nor YouTube changes",
      /the live thumbnail and YouTube are unchanged until you press a new tile/.test(
        await page.locator("#thumbmsg").innerText(),
      ),
    );
    let onStrip = false;
    const after = await rerender(page, id, async () => {
      for (let i = 0; i < 20 && !onStrip; i++) {
        const n = await page.request.get(base + "/api/nightly").then((r) => r.json());
        onStrip = (n.activity?.running ?? []).some(
          (r) => r.step === "thumbnails" && r.matchId === Number(id),
        );
        if (!onStrip) await page.waitForTimeout(250);
      }
    });
    check("the strip's activity line carries the re-render", onStrip);
    check(
      "the live variants, manifest and thumbnail.png are byte-identical",
      same(await liveFiles(page, id), liveBefore),
    );
    const key = before.variants[0].key;
    const newKeys = (after.newVariants ?? []).map((v) => v.key);
    const newImage = await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}&new=1`);
    check(
      "a new set in today's design beside the old one",
      newKeys.length === 4 && newImage.length > 5000 && !newImage.equals(liveBefore.files[1]),
      newKeys.join(","),
    );
    const tiles = page.locator("#variants .variant:has(.ytput)");
    check(
      "each new tile offers Put on YouTube, none Use this",
      (await tiles.count()) === 4 && (await page.locator("#variants .promote").count()) === 0,
    );
    const src = await tiles.first().locator("img").getAttribute("src");
    check("the panel asks for the new stills, not cached ones", src.includes("&new=1&r="), src);
    const oldLink = page.locator(".thumbnew a[download]");
    check(
      "no image kept from YouTube yet: the old image is labelled the dashboard's thumbnail.png",
      (await oldLink.getAttribute("href")) === `/api/thumbnail/${id}` &&
        /dashboard’s thumbnail\.png/.test(await oldLink.innerText()),
    );
    check(
      "a download per new tile",
      (await page.$$eval(
        "#variants .variant a[download]",
        (as) => as.filter((a) => a.href.includes("&new=1")).length,
      )) === 4,
    );
    await shoot(page, "desktop-after-rerender");
    check(
      "Put on YouTube says what it replaces",
      /replaces the thumbnail on “.+” with that tile/.test(await page.locator("#thumbytmsg").innerText()),
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
    check(
      "the old image is now the one kept from YouTube",
      (await oldLink.getAttribute("href")) === `/api/thumbnail/${id}?kept=1` &&
        /YouTube had before/.test(await oldLink.innerText()),
    );
    await shoot(page, "desktop-after-put");
    // A second re-render empties the new set while it runs: the put's line and its Undo stay.
    let duringLine = "";
    let duringUndo = 0;
    await rerender(page, id, async () => {
      // Once the run has emptied the new set (it reads the match first), which the panel's poll shows.
      await page.waitForSelector(".thumbnew", { state: "detached", timeout: 30000 });
      // Read as it is now, not waited for: a missing line must not be answered by the one painted after.
      [duringLine, duringUndo] = await page.evaluate(() =>
        document.querySelector("#thumbrerender[disabled]")
          ? [
              document.querySelector("#thumbytmsg")?.textContent ?? "",
              document.querySelectorAll("#thumbundo").length,
            ]
          : ["(the run had ended)", 0],
      );
      await shoot(page, "desktop-during-second-rerender");
    });
    check(
      "during a second re-render the put's line stays",
      duringLine.includes(`on YouTube since`) && duringLine.includes(putKey),
      duringLine,
    );
    check("...and Undo with it", duringUndo === 1);
    check("the live set is still byte-identical", same(await liveFiles(page, id), liveBefore));
    await page.click("#thumbundo");
    await page.waitForFunction(() =>
      /the image it had before/.test(document.querySelector("#thumbytmsg")?.textContent),
    );
    check("Undo sends undo", JSON.stringify(sent.at(-1)) === JSON.stringify({ undo: true }));
    // No file to offer as the old image: no link, rather than one that 404s.
    patch = (p) => ({ ...p, hasLive: false, youtube: { ...p.youtube, canUndo: false } });
    await page.evaluate((m) => loadVariants(Number(m)), id);
    check("no old image on disk: no download link for it", (await oldLink.count()) === 0);
    patch = null;

    /* --- Not on the channel: Use this moves the new set over the live one --------------------- */
    await open(page, offId);
    const offBefore = await panel(page, offId);
    check("the second match is not on the channel", offBefore.onChannel === false);
    const offLive = await liveFiles(page, offId);
    const offAfter = await rerender(page, offId);
    check(
      "a re-render of it leaves the live set byte-identical too",
      same(await liveFiles(page, offId), offLive),
    );
    const promote = page.locator("#variants .variant:has(.promote)");
    check(
      "each new tile offers Use this, none Put on YouTube",
      (await promote.count()) === 4 && (await page.locator("#variants .ytput").count()) === 0,
    );
    check(
      "and says what it does",
      /Use this makes the new set the live one/.test(await page.locator(".thumbnew").innerText()),
    );
    // The channel list not read yet: neither press, and the panel says why.
    patch = (p) => ({ ...p, onChannel: null });
    await page.evaluate((m) => loadVariants(Number(m)), offId);
    check(
      "channel unknown: no Use this, no Put, 'checking the channel'",
      (await page.locator("#variants .promote, #variants .ytput").count()) === 0 &&
        /checking the channel — reload in a moment/.test(await page.locator(".thumbnew").innerText()),
    );
    patch = null;
    await page.evaluate((m) => loadVariants(Number(m)), offId);
    await shoot(page, "desktop-not-on-channel-new-set");
    const useKey = await promote.nth(2).getAttribute("data-key");
    const picked = await bytes(page, `/api/thumbnail/${offId}?v=${encodeURIComponent(useKey)}&new=1`);
    check("the live set has not changed before the press", same(await liveFiles(page, offId), offLive));
    await promote.nth(2).locator(".promote").click();
    await page.waitForFunction(
      () => !document.querySelector("#variants .promote") && document.querySelector("#variants .is-chosen"),
    );
    const promoted = await panel(page, offId);
    check(
      "the new set is the live one now",
      promoted.newVariants === null &&
        JSON.stringify(promoted.variants.map((v) => v.key)) ===
          JSON.stringify(offAfter.newVariants.map((v) => v.key)),
    );
    check(
      "the pressed tile is chosen by the operator",
      promoted.chosen === useKey && promoted.chosenBy === "operator",
    );
    check("thumbnail.png is that tile", (await bytes(page, `/api/thumbnail/${offId}`)).equals(picked));
    check(
      "its live variant is the new still",
      (await bytes(page, `/api/thumbnail/${offId}?v=${encodeURIComponent(useKey)}`)).equals(picked),
    );
    const liveSrc = await page.locator(`#variants .variant.chosen img`).getAttribute("src");
    check(
      "the panel shows it in use, fetched afresh",
      /&r=\d/.test(liveSrc) &&
        (await page.locator(`#variants .variant.chosen[data-key="${useKey}"] .is-chosen`).count()) === 1,
      liveSrc,
    );
    check(
      "the line no longer speaks of a set waiting beside the live one",
      /^draws every pose again/.test(await page.locator("#thumbmsg").innerText()),
    );
    await shoot(page, "desktop-after-use-this");

    /* --- The bulk: a Settings row, render only ---------------------------------------------------- */
    await page.click("#tab-settings");
    await page.waitForSelector("#thumbsall");
    check(
      "Settings offers the bulk re-render, and says nothing changes on YouTube",
      /every uploaded video/.test(await page.locator("#thumbsall").innerText()) &&
        /nothing changes on YouTube/.test(
          await page.locator("#thumbsall").locator("xpath=../..").innerText(),
        ),
    );

    /* --- The phone: the Package group on its own -------------------------------------------------- */
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
    const heights = async (sel) =>
      phone.$$eval(sel, (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    const links = await heights("#variants a[download]");
    check(
      "the phone's Re-render, Put and download links are 44 px targets",
      (await heights("#thumbrerender"))[0] >= 44 &&
        (await heights("#variants .ytput")).every((h) => h >= 44) &&
        links.length === 5 &&
        links.every((h) => h >= 44),
      `downloads ${links.join(",")}`,
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
      await phone.evaluate((m) => select(Number(m), { open: true }), offId);
      await phone.click('.jump [data-panel="package"]');
      await phone.waitForSelector("#variants .is-chosen");
      await phone.screenshot({ path: `${shots}/phone-not-on-channel.png` });
    }

    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("ran to the end", false, e.message);
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})();
