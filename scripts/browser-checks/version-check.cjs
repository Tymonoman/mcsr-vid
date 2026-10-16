const { launchFor } = require("./launch.cjs");
(async () => {
  const [base] = process.argv.slice(2);
  const browser = await launchFor(base);
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
    const n0 = await page.evaluate(async () => await (await fetch("/api/nightly")).json());
    const code = n0.code;
    const strip0 = (await page.textContent("#nightly")).replace(/\s+/g, " ");
    check(
      "payload carries boot, now and needsRestart",
      code &&
        /^[0-9a-f]{7}$/.test(code.boot || "") &&
        /^[0-9a-f]{7}$/.test(code.now || "") &&
        typeof code.needsRestart === "boolean",
      JSON.stringify(code),
    );
    // The line appears exactly when the commits since boot touched code the server holds.
    check(
      code.needsRestart ? "a server behind on code says so" : "no restart line without new server code",
      /repo is at/.test(strip0) === (code.needsRestart && (!n0.restart || !!n0.restart.error)),
      strip0.slice(0, 100),
    );
    // Everything below is faked in this page only: the POST never leaves the browser, so the
    // check stays read-only against the real dashboard.
    let fake = { needsRestart: true, restart: null };
    let posts = 0;
    await page.route("**/api/nightly", async (r) => {
      const d = await (await r.fetch()).json();
      d.code = { boot: "abc1234", now: d.code.now, needsRestart: fake.needsRestart };
      d.restart = fake.restart;
      return r.fulfill({ json: d });
    });
    await page.route("**/api/restart-when-idle", (r) => {
      if (r.request().method() !== "POST") return r.fulfill({ json: fake.restart });
      posts++;
      fake.restart = { armedAt: new Date().toISOString(), lastCheck: null, blockedBy: [] };
      return r.fulfill({ status: 202, json: fake.restart });
    });
    const stripNow = async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('#nightly [data-act="nightly-run"]');
      return (await page.textContent("#nightly")).replace(/\s+/g, " ");
    };

    fake.needsRestart = false;
    const docsOnly = await stripNow();
    check("a docs-only move says nothing", !/repo is at/.test(docsOnly), docsOnly.slice(0, 100));

    fake.needsRestart = true;
    const strip1 = await stripNow();
    check(
      "new server code is named with both commits and the safe restart, strip intact",
      /running abc1234; the repo is at [0-9a-f]{7} · Restart when idle/.test(strip1) &&
        /Next .*UTC/.test(strip1) &&
        /Run now/.test(strip1),
      strip1.slice(0, 160),
    );
    check("no docker restart in the strip", !/docker restart/.test(strip1), strip1.slice(0, 160));

    await page.click('#nightly [data-act="restart-when-idle"]');
    await page.waitForSelector("#nightly .restartline");
    const armed = (await page.textContent("#nightly")).replace(/\s+/g, " ");
    check(
      "pressed: one POST, the button gives way to the pending line",
      posts === 1 && /restart pending · first check within 30 s/.test(armed) && !/repo is at/.test(armed),
      `${posts} · ${armed.slice(0, 160)}`,
    );

    fake.restart = {
      ...fake.restart,
      lastCheck: new Date().toISOString(),
      blockedBy: ["an upload", "a render"],
    };
    const waiting = await stripNow();
    check(
      "armed, it names what it waits for",
      /restart pending · waiting for: an upload, a render/.test(waiting) &&
        !/Restart when idle/.test(waiting),
      waiting.slice(0, 160),
    );

    fake.restart = { ...fake.restart, blockedBy: [], error: "src/x.ts(1,1): error TS1005" };
    const failed = await stripNow();
    check(
      "a failed boot check offers the button again",
      /boot check failed: src\/x\.ts/.test(failed) && /Restart when idle/.test(failed),
      failed.slice(0, 200),
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
