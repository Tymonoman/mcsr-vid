const { chromium, readClipboard } = require("./launch.cjs");
const { firefox } = require("playwright");

/* The Publish kit's publish time, typed the way the operator types it — in Firefox as well as
   Chromium (26 Sept 2026: "on firefox i cant change the upload date. theres just no way to edit
   the input box"), at desktop and phone width, in Europe/Warsaw so local-to-UTC is exercised.
   Usage: node publish-at-check.cjs <base> <unuploaded id> [scheduled id] [published id] [shots dir]
   The unuploaded match gets a time saved and then goes back to the next free slot (or to the time
   it had). The scheduled one's "Move on YouTube" is answered in the browser: nothing reaches the
   server's YouTube call, let alone YouTube. */
(async () => {
  const [base, openId, scheduledId, publishedId, shots] = process.argv.slice(2);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const publishOf = (id) =>
    fetch(`${base}/api/publishkit/${id}`)
      .then((r) => r.json())
      .then((k) => k.publish);
  const before = await publishOf(openId);
  // A quarter past the scheduled video's time, as the field takes it in Warsaw: the same UTC hour.
  const sched = scheduledId ? await publishOf(scheduledId) : null;
  if (scheduledId && sched?.state !== "scheduled")
    console.log(
      `SKIP the Move checks -- ${scheduledId} is ${sched?.state ?? "unknown"}, not scheduled on YouTube`,
    );
  const clashMs = sched?.state === "scheduled" ? Date.parse(sched.at) + 15 * 60_000 : null;
  const clashAt = clashMs
    ? new Date(clashMs).toLocaleString("sv-SE", { timeZone: "Europe/Warsaw" }).replace(" ", "T").slice(0, 16)
    : null;
  // 2 October 2026, 21:30 in Warsaw (CEST, +02:00) is 19:30 UTC.
  const TYPED = "2026-10-02T21:30";
  const TYPED_UTC = "2026-10-02T19:30:00.000Z";
  /** Month, day, year, then the time: Firefox moves on to the hour by itself after a 4-digit year, Chromium needs the Tab. */
  const typeWhen = async (page, name, sel) => {
    await page.locator(sel).scrollIntoViewIfNeeded();
    const box = await page.locator(sel).boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.keyboard.type("10022026");
    if (name === "chromium") await page.keyboard.press("Tab");
    await page.keyboard.type("0930P");
  };
  const tall = async (page, sel) => ((await page.locator(sel).boundingBox())?.height ?? 0) >= 44;

  try {
    for (const [name, type] of [
      ["chromium", chromium],
      ["firefox", firefox],
    ]) {
      const browser = await type.launch();
      try {
        for (const [vp, viewport] of [
          ["desktop", { width: 1400, height: 1000 }],
          ["phone", { width: 390, height: 844 }],
        ]) {
          const tag = `${name} ${vp}`;
          const ctx = await browser.newContext({
            viewport,
            locale: "en-US",
            timezoneId: "Europe/Warsaw",
            hasTouch: vp === "phone",
          });
          const page = await ctx.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          const open = async (id) => {
            await page.goto(base + "/", { waitUntil: "networkidle" });
            await page.evaluate((id) => select(Number(id), { open: true }), id);
            if (vp === "phone") {
              await page.waitForSelector('#detail .jump a[data-panel="publish"]', { timeout: 30000 });
              await page.click('#detail .jump a[data-panel="publish"]');
            }
            await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
          };

          /* --- Not uploaded: type a time, save it, see it come back, clear it ------------------ */
          await open(openId);
          const field = page.locator("#kitWhen");
          check(
            `${tag}: the field is there and editable`,
            (await field.count()) === 1 && (await field.isEditable()),
          );
          if (vp === "phone") {
            check(`${tag}: the field is a 44 px target`, await tall(page, "#kitWhen"));
            check(`${tag}: Save is a 44 px target`, await tall(page, "#kitWhenSave"));
          }
          const shown = await field.inputValue();
          await typeWhen(page, name, "#kitWhen");
          check(
            `${tag}: typing changes the field`,
            (await field.inputValue()) === TYPED,
            `${shown} -> ${await field.inputValue()}`,
          );
          if (shots)
            await page
              .locator("#publishkit .kit:has(#kitWhen)")
              .screenshot({ path: `${shots}/publish-at-${name}-${vp}-typed.png` });
          await page.click("#kitWhenSave");
          await page.waitForFunction(
            () => /saved/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            null,
            {
              timeout: 15000,
            },
          );
          const saved = await publishOf(openId);
          check(
            `${tag}: the server keeps it, in UTC`,
            saved.chosen === true && saved.at === TYPED_UTC,
            JSON.stringify(saved),
          );
          check(`${tag}: the field shows the saved time`, (await field.inputValue()) === TYPED);
          const line = await page.locator("#publishkit .kit:has(#kitWhen) textarea").inputValue();
          check(
            `${tag}: the copy line names it with UTC beside`,
            /Oct 2.*09:30 PM \(19:30 UTC\)/.test(line),
            line,
          );
          await page.locator("#publishkit .kit:has(#kitWhen) button.copy").click();
          await page.waitForTimeout(300);
          check(`${tag}: Copy still copies the line`, (await readClipboard(page)) === line);
          // Back from a reload: the value round-trips through the server, not the page's memory.
          await open(openId);
          check(
            `${tag}: after a reload the field holds it`,
            (await page.locator("#kitWhen").inputValue()) === TYPED,
          );
          check(
            `${tag}: and says it is the operator's`,
            /your time/.test(await page.locator("#publishkit .kit:has(#kitWhen) .kithead").innerText()),
          );
          if (shots)
            await page
              .locator("#publishkit .kit:has(#kitWhen)")
              .screenshot({ path: `${shots}/publish-at-${name}-${vp}-saved.png` });
          if (vp === "desktop") {
            // Now's Video up names the chosen time (a playoff game before its join has no steps).
            await page.waitForSelector("#now .step, #now .seriesnote", { timeout: 30000 });
            const now = await page.locator("#now").innerText();
            if ((await page.locator("#now .step").count()) === 0)
              console.log(`SKIP ${tag}: Now -- ${openId} is a playoff game, uploaded from game 1`);
            else
              check(
                `${tag}: Now's Video up names it`,
                /Oct 2.*09:30 PM.*your time/i.test(now),
                now.match(/Video up[^\n]*\n?[^\n]*/)?.[0],
              );
          }
          // A time in the past is refused with a plain line under the button.
          await page.locator("#kitWhen").fill("2020-01-01T10:00");
          await page.click("#kitWhenSave");
          await page.waitForSelector(".kit .inlinefail", { timeout: 10000 });
          check(
            `${tag}: the past is refused`,
            /has passed/.test(await page.locator(".kit .inlinefail").innerText()),
          );
          // The slot rules are warnings: an hour another video holds still saves, and says so.
          if (clashAt) {
            await page.locator("#kitWhen").fill(clashAt);
            await page.click("#kitWhenSave");
            await page.waitForSelector("#publishkit .kitwarn", { timeout: 15000 });
            const warned = await publishOf(openId);
            check(
              `${tag}: a taken hour saves with a warning`,
              warned.chosen === true &&
                warned.at === new Date(clashMs).toISOString() &&
                /another video is scheduled for that hour/.test(
                  await page.locator("#publishkit .kitwarn").first().innerText(),
                ),
              JSON.stringify(warned),
            );
            if (shots)
              await page
                .locator("#publishkit .kit:has(#kitWhen)")
                .screenshot({ path: `${shots}/publish-at-${name}-${vp}-warned.png` });
          }
          await page.click("#kitWhenFree");
          await page.waitForFunction(
            () => /next free slot/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            null,
            {
              timeout: 15000,
            },
          );
          const cleared = await publishOf(openId);
          check(
            `${tag}: "use the next free slot" clears it`,
            cleared.chosen === false,
            JSON.stringify(cleared),
          );
          check(
            `${tag}: and the field shows the slot`,
            (await page.locator("#kitWhen").inputValue()) !== TYPED,
          );

          /* --- Scheduled on YouTube: the button says it moves it there ---------------------------- */
          if (sched?.state === "scheduled") {
            let sent = null;
            await page.route(`**/api/shorts/publishat/${scheduledId}`, (route) => {
              sent = JSON.parse(route.request().postData() ?? "{}");
              route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  publishAt: sent.publishAt,
                  message: "YouTube has it for (stubbed in the browser)",
                }),
              });
            });
            await open(scheduledId);
            const btn = page.locator("#kitWhenSave");
            check(
              `${tag}: a scheduled video's button moves it`,
              /^Move on YouTube to /.test(await btn.innerText()),
              await btn.innerText(),
            );
            await typeWhen(page, name, "#kitWhen");
            check(
              `${tag}: typing renames the button`,
              /Oct 2.*09:30 PM/.test(await btn.innerText()),
              await btn.innerText(),
            );
            if (shots)
              await page
                .locator("#publishkit .kit:has(#kitWhen)")
                .screenshot({ path: `${shots}/publish-at-${name}-${vp}-scheduled.png` });
            await btn.click();
            await page.waitForFunction(
              () => /stubbed/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
              null,
              {
                timeout: 15000,
              },
            );
            check(
              `${tag}: the press asks for the move, in UTC`,
              sent?.move === true && sent?.publishAt === TYPED_UTC,
              JSON.stringify(sent),
            );
            await page.unroute(`**/api/shorts/publishat/${scheduledId}`);
          }

          /* --- Published: a copy block, nothing to edit ------------------------------------------- */
          if (publishedId) {
            await open(publishedId);
            check(`${tag}: a published video has no field`, (await page.locator("#kitWhen").count()) === 0);
            const kit = page.locator('#publishkit .kit:has(.kitlabel:text-is("Publish at")) textarea');
            check(
              `${tag}: it says published`,
              /^published /.test(await kit.inputValue()),
              await kit.inputValue(),
            );
          }
          check(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    // Whatever happened above, the match keeps the time it came with.
    await fetch(`${base}/api/shorts/publishat/${openId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishAt: before.chosen ? before.at : null }),
    });
  }
  process.exitCode = ok ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
