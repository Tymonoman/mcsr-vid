// The title-editor flow the morning depends on: a chip click reaches the YouTube title and the
// kit; Save commits the hook into the title file, the checklist's hook fact flips, and the panels
// repaint from the saved meta. Restores the edited title afterwards.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const [base, id] = process.argv.slice(2);
  const edited = `/media/${id}/match-${id}.title.edited.txt`;
  const had = fs.existsSync(edited) ? fs.readFileSync(edited, "utf8") : null;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
    if (!cond) ok = false;
  };
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
    await page.waitForSelector("#ytTitle", { timeout: 30000 });
    const chip = await page.$("#detail .chip");
    check("a hook chip exists", !!chip);
    const chipText = (await chip.textContent()).trim();
    await chip.click();
    await page.waitForTimeout(150);
    const ytTitle = await page.$eval("#ytTitle", (e) => e.value);
    const kitTitle = await page.$eval(
      '#publishkit .kit:has(.kitlabel:text-is("Title")) textarea',
      (t) => t.value,
    );
    check(
      "YouTube title follows the chip",
      ytTitle.includes(chipText) && !ytTitle.includes("<HOOK>"),
      ytTitle,
    );
    check(
      "kit title follows the chip",
      kitTitle.includes(chipText) && !kitTitle.includes("<HOOK>"),
      kitTitle,
    );
    const before = (await page.textContent("#checklist")).replace(/\s+/g, " ");
    check(
      "checklist hook fact unticked before save",
      /·\s*hook/i.test(before) || !/✓\s*hook/i.test(before),
      before.slice(0, 120),
    );
    await page.click("#save");
    await page.waitForFunction(() => document.querySelector("#savedmsg")?.textContent === "saved", {
      timeout: 10000,
    });
    await page.waitForTimeout(1500);
    const titleField = await page.$eval("#title", (e) => e.value.split("\n")[0]);
    check(
      "title editor first line carries the hook",
      titleField.includes(chipText) && !titleField.includes("<HOOK>"),
      titleField,
    );
    const onDisk = fs.readFileSync(edited, "utf8").split("\n")[0];
    check("title file on disk carries the hook", onDisk.includes(chipText), onDisk);
    const after = (await page.textContent("#checklist")).replace(/\s+/g, " ");
    check("checklist hook fact ticked after save", /✓\s*hook/i.test(after), after.slice(0, 120));
    const ytAfter = await page.$eval("#ytTitle", (e) => e.value);
    check(
      "YouTube panel repainted with the saved title",
      ytAfter.includes(chipText) && !ytAfter.includes("<HOOK>"),
      ytAfter,
    );
    const kitAfter = await page.$eval(
      '#publishkit .kit:has(.kitlabel:text-is("Title")) textarea',
      (t) => t.value,
    );
    check("kit repainted with the saved title", kitAfter.includes(chipText), kitAfter);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    if (had === null) fs.rmSync(edited, { force: true });
    else fs.writeFileSync(edited, had);
    console.log("restored:", had === null ? "removed edited title" : "previous edited title put back");
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
