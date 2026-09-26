const { launchFor } = require("./launch.cjs");

/* "Re-render thumbnails" and the swap on YouTube, pressed the way the operator does.
   Usage: node thumbs-rerender-check.cjs <base> <uploaded match id> [screenshot dir]

   The re-render is REAL: it redraws the match's variants on the server and keeps the old set in
   thumbnail-prev/ -- run it against a test server on a scratch copy of the media, not the lab.
   The swap is NOT: POST /api/thumbnails/:id/youtube is answered in the browser, and the GET is
   patched to say YouTube is connected, so no thumbnails.set can reach the live channel. What it
   pins there is the button, its wording, what it sends and the line it leaves. */
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

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("pageerror", (e) => errors.push(e.message));

    // The swap, answered here. `put` records what the page sent; the GET says what YouTube wears.
    const sent = [];
    let set = null;
    // The tile in use when Put is pressed: YouTube's stubbed answer names it, as the real one would.
    let putKey = null;
    await page.route(new RegExp(`/api/thumbnails/${id}$`), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const real = await (await route.fetch()).json();
      if (real.youtube) Object.assign(real.youtube, { connected: true, set, canUndo: set !== null });
      await route.fulfill({ json: real });
    });
    await page.route(new RegExp(`/api/thumbnails/${id}/youtube$`), async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      sent.push(body);
      set = { variant: body.undo ? null : putKey, at: new Date().toISOString() };
      await route.fulfill({ json: { videoId: "stubbed0000", title: "Stubbed title", set } });
    });

    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((m) => select(Number(m), { open: true }), id);
    await page.waitForSelector("#thumbrerender", { timeout: 20000 });
    await page.locator("#h-thumbs").scrollIntoViewIfNeeded();

    const before = await page.request.get(`${base}/api/thumbnails/${id}`).then((r) => r.json());
    const key = before.variants[0].key;
    const oldVariant = await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}`);
    const oldLive = await bytes(page, `/api/thumbnail/${id}`);
    check(
      "the line says YouTube is not changed by it",
      /nothing on YouTube changes|YouTube is unchanged/.test(await page.locator("#thumbmsg").innerText()),
    );

    await page.click("#thumbrerender");
    // The strip's activity line names it while it runs.
    let onStrip = false;
    for (let i = 0; i < 20 && !onStrip; i++) {
      const n = await page.request.get(base + "/api/nightly").then((r) => r.json());
      onStrip = (n.activity?.running ?? []).some((r) => r.step === "thumbnails" && r.matchId === Number(id));
      if (!onStrip) await page.waitForTimeout(250);
    }
    check("the strip's activity line carries the re-render", onStrip);
    await page.waitForFunction(
      () => /re-rendered|failed/.test(document.querySelector("#thumbmsg")?.textContent ?? ""),
      null,
      {
        timeout: 240000,
      },
    );
    const msg = await page.locator("#thumbmsg").innerText();
    check("the re-render finished", /re-rendered/.test(msg), msg);

    const newVariant = await bytes(page, `/api/thumbnail/${id}?v=${encodeURIComponent(key)}`);
    check(
      "the variant is a new image (on a match last drawn in an older design)",
      !newVariant.equals(oldVariant),
    );
    check(
      "thumbnail.png (what the video wears) is untouched",
      (await bytes(page, `/api/thumbnail/${id}`)).equals(oldLive),
    );
    const job = (await page.request.get(`${base}/api/thumbnails/${id}`).then((r) => r.json())).job;
    const src = await page.locator("#variants .variant img").first().getAttribute("src");
    check(
      "the panel asks for the new stills, not the cached old ones",
      src.endsWith(`&r=${encodeURIComponent(job.since)}`),
      src,
    );
    const tiles = await page.locator("#variants .variant img").count();
    check(
      "the new variants are in the panel",
      tiles === before.variants.filter((v) => !v.hook).length,
      `${tiles} tiles`,
    );
    check(
      "nobody has looked at them yet: the chosen tile asks to be kept",
      (await page.locator("#variants .variant.chosen .use").innerText()) === "Keep this",
    );
    check(
      "no swap is offered before a variant is confirmed",
      (await page.locator("#variants .ytput").count()) === 0,
    );
    if (shots)
      await page
        .locator('section[data-panel="package"]')
        .screenshot({ path: `${shots}/desktop-after-rerender.png` });

    await page.click("#variants .variant.chosen .use");
    await page.waitForSelector("#variants .ytput", { timeout: 10000 });
    const says = await page.locator("#thumbytmsg").innerText();
    check("Put on YouTube says what it replaces", /replaces the thumbnail on “.+”/.test(says), says);
    putKey = await page.locator("#variants .variant.chosen").getAttribute("data-key");
    await page.click("#variants .ytput");
    await page.waitForFunction(() =>
      /YouTube accepted it/.test(document.querySelector("#thumbytmsg")?.textContent ?? ""),
    );
    const accepted = await page.locator("#thumbytmsg").innerText();
    check("the line names the tile in use", putKey && accepted.includes(`now wears ${putKey}`), accepted);
    check(
      "it sent one put",
      JSON.stringify(sent) === JSON.stringify([{ undo: false }]),
      JSON.stringify(sent),
    );
    check(
      "and says what YouTube answered",
      /Stubbed title/.test(await page.locator("#thumbytmsg").innerText()),
    );
    check("Undo is offered after a put", (await page.locator("#thumbundo").count()) === 1);
    if (shots)
      await page
        .locator('section[data-panel="package"]')
        .screenshot({ path: `${shots}/desktop-after-put.png` });
    await page.click("#thumbundo");
    await page.waitForFunction(() =>
      /the image it had before/.test(document.querySelector("#thumbytmsg")?.textContent ?? ""),
    );
    check("Undo sends undo", JSON.stringify(sent.at(-1)) === JSON.stringify({ undo: true }));

    // The bulk: a Settings row, render only.
    await page.click("#tab-settings");
    await page.waitForSelector("#thumbsall");
    check(
      "Settings offers the bulk re-render",
      /every uploaded video/.test(await page.locator("#thumbsall").innerText()),
    );
    check(
      "and says nothing changes on YouTube",
      /nothing changes on YouTube/.test(await page.locator("#thumbsall").locator("xpath=../..").innerText()),
    );

    // The phone: the Package group on its own.
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(base + "/", { waitUntil: "networkidle" });
    await phone.evaluate((m) => select(Number(m), { open: true }), id);
    await phone.click('.jump [data-panel="package"]');
    await phone.waitForSelector("#thumbrerender");
    const box = await phone.locator("#thumbrerender").boundingBox();
    check("the phone's button is a 44 px target", box && box.height >= 44, JSON.stringify(box));
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check("no sideways scroll on the phone", wide);
    if (shots) await phone.screenshot({ path: `${shots}/phone-package.png` });

    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("ran to the end", false, e.message);
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})();
