// The match screen after the strip-down: no third copy of the title, a title box without the
// terminal's guidance, the after-the-upload pastes folded, no Chapters panel, no disabled Stop,
// the Kdenlive project as a download, and a refused checklist toggle that stays on the page.
// Changes nothing: the only write it provokes (a publish toggle) is intercepted and refused.
const { launchFor, readClipboard } = require("./launch.cjs");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await launchFor(base);
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  let ok = true;
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
    if (!cond) ok = false;
  };
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#publishkit .kit", { timeout: 30000 });

    // 1. the resolved title is in the kit and the YouTube field, and nowhere else
    check("no hook preview line", (await page.$("#hookpreview")) === null);

    // 2. the title box holds a title, not formatTitle's guidance for the terminal
    const title = await page.$eval("#title", (e) => e.value);
    check(
      "title box is one line, no guidance",
      !title.includes("\n") && !/Replace <HOOK>/.test(title),
      JSON.stringify(title.slice(0, 90)),
    );

    // 3. everything pasted after the upload is folded, and Copy still reaches inside it
    const folded = await page.$$eval("#publishkit details.after .kitlabel", (n) =>
      n.map((e) => e.textContent.trim()),
    );
    check(
      "after-the-upload blocks are inside the fold",
      ["Short title", "Pinned comment", "Community post"].every((l) => folded.includes(l)),
      folded.join(" | "),
    );
    const open = await page.$eval("#publishkit details.after", (d) => d.open);
    check("the fold starts closed", open === false);
    const pinned = await page.$(`#publishkit .kit:has(.kitlabel:text-is("Pinned comment"))`);
    const text = await pinned.$eval("textarea", (t) => t.value);
    await pinned.$eval("button.copy", (b) => b.click());
    await page.waitForTimeout(300);
    check("Copy works inside the fold", (await readClipboard(page)) === text);

    // 4. the description already is the chapter list
    const headings = await page.$$eval("#detail h2", (n) => n.map((e) => e.textContent.trim()));
    check("no Chapters panel", !headings.some((h) => /^Chapters/.test(h)), headings.join(" | "));

    // 5. Stop is not furniture in the first row
    check("Stop is hidden with nothing running", await page.$eval("#stop", (b) => b.hidden));

    // 6. the one output that is fetched rather than read
    const href = await page.$eval(".outputs a", (a) => a.getAttribute("href"));
    check("Kdenlive row links to the project route", href === `/api/export/project/${id}`, href);
    const status = await page.evaluate(async (h) => (await fetch(h)).status, href);
    check("the project route serves it", status === 200, String(status));

    // 7. a refused checklist toggle reports where it was clicked, not in a modal
    await page.route("**/api/publish/**", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, json: { error: "publish.json is read-only" } })
        : route.continue(),
    );
    await page.click("#checklist button.pill");
    await page.waitForSelector("#checklist .pillfail", { timeout: 5000 });
    const failText = await page.textContent("#checklist .pillfail");
    check("the refusal is inline", /read-only/.test(failText), failText);
    check("nothing blocked the page", dialogs.length === 0, dialogs.join(" | "));

    // 8. the border token that used to fall through to a literal
    const border = await page
      .$eval(".moment:not(:first-child)", (e) => getComputedStyle(e).borderTopColor)
      .catch(() => "no moments");
    check(
      "moment border uses --panel-edge-light",
      border === "rgb(60, 56, 68)" || border === "no moments",
      border,
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
