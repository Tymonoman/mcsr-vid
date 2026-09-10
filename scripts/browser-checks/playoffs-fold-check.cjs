const { chromium } = require("playwright");

/* The playoffs board is folded away until a game exists or the first slot is inside 24 h. Both
   branches are driven from a doctored /api/playoffs so the check means the same thing on the
   Tuesday before a bracket and on the Saturday of one; the live payload is checked too. */
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };

  /** Loads the dashboard with `shift` applied to every slot's startTime, and reports the board. */
  const board = async (shift) => {
    await page.unrouteAll();
    if (shift !== null) {
      await page.route("**/api/playoffs", async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        const at = Math.floor(Date.now() / 1000) + shift;
        data.slots = data.slots.map((s) => ({ ...s, startTime: at, games: [] }));
        await route.fulfill({ response: res, json: data });
      });
    }
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    return {
      folds: await page.locator("#playoffs details.playoffsoon").count(),
      rows: await page.locator("#playoffs .sugg.playoff:visible").count(),
      slots: await page.locator("#playoffs .sugg.playoff").count(),
    };
  };

  try {
    const live = await page.request.get(base + "/api/playoffs");
    const payload = live.ok() ? await live.json() : { slots: [] };
    if (!payload.slots || payload.slots.length === 0) {
      console.log("PASS playoffs-fold -- no bracket in range, nothing to fold");
      await browser.close();
      process.exit(0);
    }

    // Days out: one summary line stands in for every slot, and opening it shows them all.
    const shut = await board(3 * 86400);
    check("a distant bracket is folded", shut.folds === 1 && shut.rows === 0, JSON.stringify(shut));
    const summary = (await page.locator("#playoffs summary").first().innerText()).trim();
    check("the summary counts the series", /\d+ series/.test(summary), summary);
    check("and dates the first one", /first \w/.test(summary), summary);
    await page.locator("#playoffs summary").first().click();
    await page.waitForTimeout(300);
    check(
      "opening it shows every slot",
      (await page.locator("#playoffs .sugg.playoff:visible").count()) === shut.slots,
      `${shut.slots} slots`,
    );

    // An hour out is the tournament: no fold to click past on the night it matters.
    const open = await board(3600);
    check("an imminent slot is not folded", open.folds === 0 && open.rows === open.slots, JSON.stringify(open));

    // A slot that has already started stays open too -- the games arrive during it.
    const during = await board(-3600);
    check("a slot underway is not folded", during.folds === 0 && during.rows === during.slots, JSON.stringify(during));

    // Whatever the calendar says today, the live payload must render one board or the other.
    const now = await board(null);
    check(
      "the live bracket renders exactly one way",
      (now.folds === 1 && now.rows === 0) || (now.folds === 0 && now.rows === now.slots),
      JSON.stringify(now),
    );
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
