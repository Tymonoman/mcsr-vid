const { chromium } = require("playwright");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#nightly [data-act="nightly-run"]');
    const code = await page.evaluate(async () => (await (await fetch("/api/nightly")).json()).code);
    const strip0 = (await page.textContent("#nightly")).replace(/\s+/g, " ");
    check(
      "payload carries boot and now",
      code && /^[0-9a-f]{7}$/.test(code.boot || "") && /^[0-9a-f]{7}$/.test(code.now || ""),
      JSON.stringify(code),
    );
    // The line appears exactly when the running commit is behind the checked-out one.
    const behind = code.boot !== code.now;
    check(
      behind ? "a server behind the repo says so" : "no restart line when current",
      /repo is at/.test(strip0) === behind,
      strip0.slice(0, 100),
    );
    await page.route("**/api/nightly", async (r) => {
      const d = await (await r.fetch()).json();
      d.code = { boot: "abc1234", now: d.code.now };
      return r.fulfill({ json: d });
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('#nightly [data-act="nightly-run"]');
    const strip1 = (await page.textContent("#nightly")).replace(/\s+/g, " ");
    check(
      "a server behind the repo is named with both commits, strip intact",
      /running abc1234; the repo is at [0-9a-f]{7} · docker restart mcsr-dashboard/.test(strip1) &&
        /Next .*UTC/.test(strip1) &&
        /Run now/.test(strip1),
      strip1.slice(0, 160),
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
