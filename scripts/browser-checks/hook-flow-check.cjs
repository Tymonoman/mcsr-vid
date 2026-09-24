// The hook flow the morning depends on, in Now: a title chip reaches the kit's title; the
// YouTube panel keeps no second copy; Save sends both hooks (PUT /api/shorts/hooks), the Hooks
// step folds to one line naming them, and the checklist's hook fact ticks from the saved plan.
// Save now schedules real uploads, so the PUT is answered here in the browser and never reaches
// the server: this check changes nothing on disk or on the channel.
const { launchFor } = require("./launch.cjs");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await launchFor(base);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
    if (!cond) ok = false;
  };
  // The server's plan as served, so the PUT's answer is that plan with the hooks saved -- and
  // saved hooks are shown unsaved again here, so the check has a Save to press on any match.
  let served = null;
  let put = null;
  await page.route("**/api/shorts/plan/*", async (r) => {
    const plan = await (await r.fetch()).json();
    served = {
      ...plan,
      titleHook: null,
      shortHook: null,
      noShort: false,
      uploads: {},
      state: "waiting-for-hook",
    };
    return r.fulfill({ json: put ? { ...served, ...put, state: "rendering" } : served });
  });
  await page.route("**/api/shorts/hooks/*", (r) => {
    put = JSON.parse(r.request().postData() ?? "{}");
    return r.fulfill({
      status: 202,
      json: { ...served, ...put, noShort: !!put.noShort, state: "rendering" },
    });
  });
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
    await page.waitForSelector("#now #hook", { timeout: 30000 });
    // The YouTube panel used to hold its own copy of the title; the upload reads the match's
    // title file server-side now, so the panel is waited on by something that still exists.
    await page.waitForSelector("#youtube", { timeout: 30000 });
    const chip = await page.$('#now .chips[data-for="hook"] .chip');
    check("a title hook chip exists", !!chip);
    const chipText = (await chip.textContent()).trim();
    await chip.click();
    await page.waitForTimeout(150);
    check("the chip fills the title hook", (await page.inputValue("#hook")) === chipText);
    const ytTitleInputs = await page.$$("#youtube textarea, #youtube input[type=text]:not(#ytAdoptId)");
    // Not "no inputs": the adopt control's video-id box is exempt by id. What must never come
    // back is a second title, which would drift from the hook field's.
    check(
      "the YouTube panel keeps no second copy of the title",
      ytTitleInputs.length === 0,
      `${ytTitleInputs.length} free-text field(s) in the panel`,
    );
    const kitTitle = () =>
      page.$eval('#publishkit .kit:has(.kitlabel:text-is("Title")) textarea', (t) => t.value);
    const before = await kitTitle();
    check("kit title follows the chip", before.includes(chipText) && !before.includes("<HOOK>"), before);
    check("typed is not saved, and says so", /not saved/.test(await page.textContent("#savedmsg")));

    // A Short hook is needed unless "No Short" is ticked: the model's line, or a chip.
    if (!(await page.inputValue("#shorthook"))) await page.fill("#shorthook", "A SHORT HOOK");
    const shortHook = await page.inputValue("#shorthook");
    await page.click("#save");
    await page.waitForFunction(
      () => /^saved\b/.test(document.querySelector("#savedmsg")?.textContent ?? ""),
      null,
      {
        timeout: 10000,
      },
    );
    check(
      "Save sends both hooks",
      put?.titleHook === chipText && put?.shortHook === shortHook && !put?.noShort,
      JSON.stringify(put),
    );
    const hooks = await page.$('#now .step[data-step="hooks"]');
    check(
      "the saved hooks fold to one line naming them",
      !(await hooks.evaluate((s) => s.classList.contains("open"))) &&
        (await hooks.textContent()).includes(chipText),
    );
    await page.waitForTimeout(1500);
    const after = (await page.textContent("#checklist")).replace(/\s+/g, " ");
    check("checklist hook fact ticked after save", /✓\s*hook/i.test(after), after.slice(0, 120));
    const ytAfter = await page.$$("#youtube textarea, #youtube input[type=text]:not(#ytAdoptId)");
    check("and still keeps none after a save", ytAfter.length === 0, `${ytAfter.length} free-text field(s)`);
    const kitAfter = await kitTitle();
    check("kit repainted with the saved hook", kitAfter.includes(chipText), kitAfter);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
