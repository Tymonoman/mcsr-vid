// The Pick step while the model's pick runs: the phase line, the clock, the percent and the bar
// (pickProgress.ts), on a desktop and a phone. The plan is answered in the browser (page.route),
// so no GET /api/shorts/plan reaches the server and no pick is queued.
// Usage: node pick-progress-check.cjs <base> [matchId] [screenshot-dir]
const { devices } = require("playwright");
const { launchFor } = require("./launch.cjs");

const LINE = "running /watch on edcr's stream · 2 of 2";
const plan = (id) => ({
  matchId: id,
  pick: null,
  shortHook: null,
  titleHook: null,
  suggestions: { short: [], title: [] },
  state: "picking",
  detail: LINE,
  pickActivity: "running",
  activity: { step: "pick", line: LINE, since: new Date(Date.now() - 42e3).toISOString(), percent: 58 },
  errors: [],
  uploads: {},
  log: [],
});

(async () => {
  let [base, id, shots = "/tmp"] = process.argv.slice(2);
  const browser = await launchFor(base);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const errors = [];
  try {
    if (!id) {
      const probe = await browser.newPage();
      const rows = (await (await probe.request.get(base + "/api/matches")).json()).matches;
      id = rows.find((m) => m.exported && !m.hidden)?.matchId;
      await probe.close();
    }
    id = Number(id);
    check("an exported match to drive", id > 0, String(id));

    const look = async (name, page) => {
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/api/shorts/plan/*", (r) => r.fulfill({ json: plan(id) }));
      await page.goto(base + "/", { waitUntil: "networkidle" });
      await page.evaluate((m) => select(m, { open: true }), id);
      const step = '#now .step[data-step="pick"]';
      await page.waitForSelector(`${step} .bar.stepbar i`, { timeout: 30000 });
      const got = await page.$eval(step, (el) => ({
        sum: el.querySelector(".sum").textContent.replace(/\s+/g, " ").trim(),
        width: el.querySelector(".bar.stepbar i").style.width,
        bar: el.querySelector(".bar.stepbar").getBoundingClientRect().toJSON(),
        fill: el.querySelector(".bar.stepbar i").getBoundingClientRect().width,
        open: el.classList.contains("open"),
      }));
      check(`${name}: the Pick step names the phase`, got.sum.includes(LINE), got.sum);
      check(`${name}: and the percent`, / · 58%$/.test(got.sum), got.sum);
      check(`${name}: the bar is 58% wide`, got.width === "58%", got.width);
      check(
        `${name}: the bar is drawn and on screen`,
        got.bar.width > 100 && got.bar.height > 0 && Math.abs(got.fill / got.bar.width - 0.58) < 0.03,
        JSON.stringify(got.bar),
      );
      await page.$eval(step, (el) => el.scrollIntoView({ block: "center" }));
      await page.locator(step).screenshot({ path: `${shots}/pick-progress-${name}.png` });
    };

    await look("desktop", await browser.newPage({ viewport: { width: 1440, height: 900 } }));
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    await look("phone", await ctx.newPage());
    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("ran to the end", false, e.stack);
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})();
