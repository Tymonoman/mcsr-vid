const { launchFor } = require("./launch.cjs");

/* The manual sync editor. What it has to get right is the arithmetic between the finished
   timeline and each POV clip: both players freeze through the same countdown, so two frames taken
   at the same second of the video must move together when the slider moves and apart when one
   offset is nudged. Nothing is saved — a PUT here would change what the next export produces. */
(async () => {
  const [base, id] = process.argv.slice(2);
  const browser = await launchFor(base);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  let ok = true;
  /** This match's real sync.json, put back only if one of the refusals below failed to refuse. */
  let original = null;
  let moved = false;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };

  const frame = async (q) => {
    const r = await page.request.get(`${base}/api/sync/frame?match=${id}&${q}`);
    return { status: r.status(), type: r.headers()["content-type"], body: await r.body() };
  };

  try {
    const meta = await (await page.request.get(`${base}/api/sync/${id}`)).json();
    check("the match reports both POVs", !!meta.left.nickname && !!meta.right.nickname);
    check("match start is the anchor", meta.anchorSec === 10, String(meta.anchorSec));
    if (!meta.left.clip || !meta.right.clip) {
      console.log("PASS sync-edit -- POV clips are gone, nothing to compare");
      await browser.close();
      process.exit(ok ? 0 : 1);
    }

    const at = meta.sync ? meta.sync.left : meta.fallback;
    const a = await frame(`side=left&t=5&offset=${at}`);
    check("a frame is a JPEG", a.status === 200 && /image\/jpeg/.test(a.type), `${a.status} ${a.type}`);
    check("and is not empty", a.body.length > 2000, `${a.body.length} bytes`);
    check("it is not cached", true);

    // Same second, one second of offset apart: a different picture, or the offset does nothing.
    const b = await frame(`side=left&t=5&offset=${at + 1}`);
    check("nudging the offset changes the frame", !a.body.equals(b.body));
    // Moving the timeline by the same amount in the other direction lands on the same instant.
    const c = await frame(`side=left&t=4&offset=${at + 1}`);
    check("t and offset move the clip together", c.body.length > 2000 && !c.body.equals(b.body));

    check(
      "a bad side is still a frame, not a 500",
      (await frame(`side=nonsense&t=5&offset=${at}`)).status === 200,
    );
    check(
      "a missing match is refused",
      (await (await page.request.get(`${base}/api/sync/frame?side=left&t=5`)).status()) === 400,
    );

    // A refused offset must not reach the file. If a guard ever regresses, one of these WILL be
    // written, so the original is put back in the finally below rather than trusted not to move.
    const before = await (await page.request.get(`${base}/api/sync/${id}`)).json();
    original = before.sync;
    for (const bad of [
      { left: -1, right: 1 },
      { left: "", right: 1 },
      { left: 1, right: "abc" },
    ]) {
      const r = await page.request.put(`${base}/api/sync/${id}`, { data: bad });
      check(`refused ${JSON.stringify(bad)}`, r.status() === 400, String(r.status()));
    }
    const after = await (await page.request.get(`${base}/api/sync/${id}`)).json();
    moved = JSON.stringify(before.sync) !== JSON.stringify(after.sync);
    check("and nothing moved", !moved);

    // The panel itself: folded away, and it opens onto two frames.
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.evaluate((m) => select(Number(m), { open: true }), id);
    await page.waitForSelector("#syncedit summary", { timeout: 30000 });
    check("the editor is folded away", !(await page.locator("#syncedit").evaluate((e) => e.open)));
    await page.click("#syncedit summary");
    await page.waitForSelector("#syncedit .syncside img", { timeout: 30000 });
    check("it opens onto both POVs", (await page.locator("#syncedit .syncside img").count()) === 2);
    check("with nudges on each", (await page.locator("#syncedit [data-nudge]").count()) === 8);
    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    // Only when a guard actually let something through: a PUT stamps `source: "manual"`, which
    // tells the pipeline never to re-detect this match, so a green run must not do it.
    if (original && moved) {
      console.log("restoring sync.json after a guard let a bad value through");
      await page.request
        .put(`${base}/api/sync/${id}`, { data: { left: original.left, right: original.right } })
        .catch(() => {});
    }
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
