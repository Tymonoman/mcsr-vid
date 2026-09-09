const { chromium } = require("playwright");
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((id) => select(Number(id), { open: true }), id);
    await page.waitForSelector("#short .moment", { timeout: 30000 });
    await page.waitForSelector("#finalvideo", { timeout: 30000 });
    const m = await page.evaluate(async (id) => await (await fetch(`/api/shorts/moments/${id}`)).json(), id);
    check("moments payload says the final video exists", m.finalVideo === true, `finalVideo=${m.finalVideo}`);
    const seeks = await page.$$("#short .moment .seek");
    check(
      "every moment carries a seek control",
      seeks.length === m.moments.length,
      `${seeks.length}/${m.moments.length}`,
    );
    // Clicking a row's control seeks the final video to that window's start (the second row, so a
    // seek that stayed at the top pick's time would be caught).
    const pick = Math.min(1, m.moments.length - 1);
    const expected = m.finalOffsetSec + m.moments[pick].startMs / 1000;
    await page.click(`#short .moment[data-pick="${pick}"] .seek`);
    await page.waitForTimeout(500);
    const t = await page.$eval("#finalvideo", (v) => v.currentTime);
    check(
      "click seeks #finalvideo to finalOffsetSec + startMs/1000",
      Math.abs(t - expected) < 1,
      `currentTime=${t} expected=${expected}`,
    );
    // A second click must drop the first window's stop listener: with two rows, seek to the
    // other one and make sure the first's end (or the second's start) does not pause it.
    if (m.moments.length > 1) {
      const other = pick === 1 ? 0 : 1;
      await page.click(`#short .moment[data-pick="${other}"] .seek`);
      await page.waitForTimeout(1500);
      const s = await page.$eval("#finalvideo", (v) => ({ paused: v.paused, t: v.currentTime }));
      const start = m.finalOffsetSec + m.moments[other].startMs / 1000;
      check(
        "a second click plays its own window, the first's listener gone",
        !s.paused && s.t >= start && s.t < start + 3,
        JSON.stringify({ ...s, start }),
      );
    }
    const label = (await page.textContent(`#short .moment[data-pick="${pick}"] .seek`)).trim();
    check("control shows the final-video clock", /\d+:\d\d$/.test(label), label);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
