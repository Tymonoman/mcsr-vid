// "Re-render with hook" says what happened: a failed render, a real render, and a no-op.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const [base, id, hook, scratch] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const lastLine = async () =>
    (await page.$$eval("#variants .scanline", (n) => n.map((e) => e.textContent.trim()))).pop() || "";
  try {
    // (a) a render that dies server-side: the POST starts, the GET reports the failure
    let fake = true;
    await page.route(`**/api/thumbnails/${id}/rerender`, (r) =>
      fake ? r.fulfill({ status: 202, json: { matchId: Number(id) } }) : r.continue(),
    );
    await page.route(`**/api/thumbnails/${id}`, async (r) => {
      if (!fake || r.request().method() !== "GET") return r.continue();
      const real = await (await r.fetch()).json();
      return r.fulfill({
        json: { ...real, rerender: { running: false, error: "Starlight Skins: 502 Bad Gateway" } },
      });
    });
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#rerender", { timeout: 30000 });
    await page.fill("#hook", hook);
    await page.click("#rerender");
    await page.waitForFunction(
      () => /re-render failed/.test(document.querySelector("#variants")?.textContent || ""),
      { timeout: 15000 },
    );
    check(
      "a failed render is reported in red",
      /re-render failed: Starlight Skins: 502/.test(await lastLine()),
      await lastLine(),
    );
    check(
      "button is back",
      await page.$eval("#rerender", (b) => !b.disabled && b.textContent.trim() === "Re-render with hook"),
    );
    // (b) the real thing, twice: to a scratch headline and back to the intended one
    fake = false;
    const clear = () => page.$$eval("#variants .scanline", (n) => n.forEach((e) => e.remove()));
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const h of [scratch, hook]) {
      await clear();
      await page.fill("#hook", h);
      await page.click("#rerender");
      await page.waitForFunction(
        () =>
          /rendered with|re-render failed|nothing to change/.test(
            document.querySelector("#variants")?.textContent || "",
          ),
        { timeout: 240000 },
      );
      const now = JSON.parse(fs.readFileSync(`/media/${id}/thumbnail.json`, "utf8")).hookText;
      check(
        `real render to "${h}" reports success`,
        new RegExp(`rendered with "${esc(h)}"`).test(await lastLine()),
        await lastLine(),
      );
      check("manifest carries it", now === h, now);
    }
    // (c) the same headline again: nothing to change, said so
    await clear();
    await page.click("#rerender");
    await page.waitForFunction(
      () =>
        /nothing to change|rendered with|re-render failed/.test(
          document.querySelector("#variants")?.textContent || "",
        ),
      { timeout: 120000 },
    );
    check(
      "a repeat with the same headline says nothing changed",
      /already rendered with .* nothing to change/.test(await lastLine()),
      await lastLine(),
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
