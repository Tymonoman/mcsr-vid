const { launchFor } = require("./launch.cjs");

/* The settings panel writes mcsr-vid.config.json — the file the dashboard boots from — so this
   drives it the way the operator does and puts every value back. What it mainly pins is what the
   panel must NOT offer: youtubeUploadEnabled and nightlyUpload are the compliance-audit gate. */
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await launchFor(base);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };

  const settings = () => page.request.get(base + "/api/settings").then((r) => r.json());
  let before = null;
  try {
    before = await settings();
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.click("#tab-settings");
    await page.waitForSelector('#settings [data-key="playoffsFirst"]', { timeout: 20000 });

    check(
      "every writable setting has an input",
      (await page.locator("#settings [data-key]").count()) === before.fields.length,
      `${await page.locator("#settings [data-key]").count()} of ${before.fields.length}`,
    );
    for (const key of ["youtubeUploadEnabled", "nightlyUpload"]) {
      check(
        `${key} is not writable from the browser`,
        (await page.locator(`#settings input[data-key="${key}"]`).count()) === 0,
      );
    }
    check("but it is still reported", (await page.locator("#settings .setrow.off").count()) >= 2);
    check(
      "the nightly's arming is stated",
      /Nightly (armed for|is)/.test(await page.locator("#settings .scanline").first().innerText()),
    );

    // Save with nothing touched must not rewrite the file.
    await page.click("#setsave");
    await page.waitForTimeout(500);
    check("a no-op save is a no-op", /nothing changed/.test(await page.locator("#setmsg").innerText()));

    // A real change round-trips through the server and comes back in the payload.
    const wasChaos = String(before.fields.find((f) => f.key === "suggestChaosSlots").value);
    const next = String(Number(wasChaos) + 1);
    await page.fill('#settings [data-key="suggestChaosSlots"]', next);
    await page.click("#setsave");
    await page.waitForTimeout(1200);
    check(
      "a real save reports what moved",
      /saved suggestChaosSlots/.test(await page.locator("#setmsg").innerText()),
    );
    check(
      "and the server agrees",
      String((await settings()).fields.find((f) => f.key === "suggestChaosSlots").value) === next,
    );

    // An out-of-range value is refused and nothing moves.
    const bad = await page.request.put(base + "/api/settings", { data: { nightlyMaxRenders: "99" } });
    check("an out-of-range value is refused", bad.status() === 400, String(bad.status()));
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    // Put every value back, whatever happened above.
    if (before) {
      const restore = {};
      for (const f of before.fields) {
        restore[f.key] =
          f.kind === "boolean"
            ? !!f.value
            : f.kind === "words"
              ? (f.value ?? []).join(" ")
              : f.value === null
                ? ""
                : String(f.value);
      }
      await page.request.put(base + "/api/settings", { data: restore }).catch(() => {});
    }
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
