// The NOW group, the way a morning uses it: every match opens on Now, the pick is glanced at,
// the two hooks are saved and the button becomes "Next waiting ›". The Short routes are answered
// in the browser (page.route) from the fixtures below -- the hooks PUT and the pick POST never
// reach the server -- so this runs against the stub or the real dashboard and changes nothing.
// Usage: node now-flow-check.cjs <base> [matchA matchB]   (two exported matches; found if omitted)
const { devices } = require("playwright");
const { launchFor, readClipboard } = require("./launch.cjs");

const NOT_SIGNED_IN = "Antigravity is not signed in. On the lab run docker exec -it mcsr-dashboard agy";
const pick = (id, extra = {}) => ({
  gameMatchId: id,
  startMs: 381000,
  endMs: 422000,
  pov: "both",
  focus: "right",
  hookSuggestion: "3.8 SECONDS APART AT THE EYES",
  why: "the lead flips at the End entry",
  kind: "race",
  source: "agy",
  model: "gemini-3.8-flash",
  createdAt: new Date().toISOString(),
  ...extra,
});
const plan = (id, extra = {}) => ({
  matchId: id,
  pick: pick(id),
  shortHook: null,
  titleHook: null,
  suggestions: {
    short: ["3.8 SECONDS APART AT THE EYES", "A SUB-8 TO WIN IT"],
    title: ["A sub-8 to win it"],
  },
  state: "waiting-for-hook",
  errors: [],
  uploads: {},
  preview: { videoUrl: `/api/export/preview/${id}`, startSec: 391, endSec: 432 },
  ...extra,
});

(async () => {
  let [base, a, b] = process.argv.slice(2);
  const browser = await launchFor(base);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const errors = [];
  /** What the box is doing now, as the strip's Activity line reads it (NightlyShortSummary.activity). */
  let activity = { running: [], queued: [] };
  const puts = [];
  const posts = [];
  const plans = {};

  /** Every Short write answered here; the plan per match from `plans`; the list and the strip
      carry the fields the contract adds (MatchRowShort, NightlyShortSummary). */
  const wire = async (page) => {
    page.on("pageerror", (e) => errors.push(e.stack.split("\n").slice(0, 3).join(" ")));
    await page.route("**/api/shorts/plan/*", (r) => {
      const id = Number(r.request().url().split("/").pop());
      return r.fulfill({ json: plans[id] ?? plan(id, { state: "published", pick: null }) });
    });
    await page.route("**/api/shorts/hooks/*", (r) => {
      const id = Number(r.request().url().split("/").pop());
      const body = JSON.parse(r.request().postData() ?? "{}");
      puts.push({ id, body });
      plans[id] = { ...plans[id], ...body, noShort: !!body.noShort, state: "rendering" };
      return r.fulfill({ status: 202, json: plans[id] });
    });
    await page.route("**/api/shorts/pick/*", (r) => {
      posts.push(Number(r.request().url().split("/").pop()));
      return r.fulfill({ status: 202, json: {} });
    });
    await page.route("**/api/matches", async (r) => {
      const d = await (await r.fetch()).json();
      for (const m of d.matches)
        if (plans[m.matchId])
          Object.assign(m, { shortState: plans[m.matchId].state, shortDetail: "Short 6:21–7:02" });
      return r.fulfill({ json: d });
    });
    await page.route("**/api/nightly", async (r) => {
      const d = await (await r.fetch()).json();
      const ids = (s) =>
        Object.values(plans)
          .filter((p) => p.state === s)
          .map((p) => p.matchId);
      return r.fulfill({
        json: {
          ...d,
          waitingForHook: ids("waiting-for-hook"),
          failed: ids("failed"),
          picker: { ok: false, message: "Antigravity is not signed in" },
          activity,
        },
      });
    });
  };

  try {
    if (!a || !b) {
      const probe = await browser.newPage();
      const rows = (await (await probe.request.get(base + "/api/matches")).json()).matches;
      const exported = rows.filter((m) => m.exported && !m.hidden).map((m) => m.matchId);
      [a, b] = exported;
      await probe.close();
    }
    a = Number(a);
    b = Number(b);
    check("two exported matches to drive", a > 0 && b > 0, `${a} ${b}`);

    // --- desktop -------------------------------------------------------------------------------
    plans[a] = plan(a, {
      pick: pick(a, { source: "heuristic", model: undefined, hookSuggestion: "DECIDED BY 1.5 SECONDS" }),
      errors: [{ step: "pick", at: new Date().toISOString(), message: NOT_SIGNED_IN }],
    });
    plans[b] = plan(b);
    activity = {
      running: [
        {
          matchId: b,
          step: "render",
          line: "encoding the Short",
          since: new Date(Date.now() - 65e3).toISOString(),
          percent: 40,
        },
      ],
      queued: [a],
    };
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await wire(page);
    await page.goto(base + "/", { waitUntil: "networkidle" });
    const now = (
      await page.$$eval("#nightly .activity", (n) => n.map((e) => e.textContent.replace(/\s+/g, " ").trim()))
    ).join(" | ");
    check(
      "the strip's Now lines name the running step, its line, clock and percent, and the queue",
      new RegExp(`cutting the Short of #${b} · encoding the Short \\(1:0\\d, 40%\\)`).test(now) &&
        /1 more pick waiting its turn/.test(now),
      now,
    );
    await page.click(`#nightly .activity [data-act="open-match"]`);
    await page.waitForFunction((id) => selected === id, b, { timeout: 10000 });
    check("a Now line opens its match", true);
    activity = { running: [], queued: [] };

    const strip = await page.textContent("#nightly");
    check(
      "the strip counts the matches waiting for a hook",
      /2 waiting for a hook/.test(strip),
      strip.slice(0, 200),
    );
    check("and says the picker is down", /Short picker: Antigravity is not signed in/.test(strip));

    await page.click('#nightly [data-act="open-first"]');
    await page.waitForSelector("#now .step", { timeout: 30000 });
    const opened = await page.evaluate(() => selected);
    check("the strip's count opens a waiting match", [a, b].includes(opened), String(opened));

    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector('#now .step[data-step="hooks"]', { timeout: 30000 });
    const steps = await page.$$eval("#now .step", (n) => n.map((s) => s.dataset.step));
    check(
      "Now lists the steps in pipeline order",
      steps.join(" ") === "video pick hooks short videoup shortup",
      steps.join(" "),
    );
    check(
      "the match opens on Now",
      (await page.getAttribute("#detail .jump a[aria-current]", "data-panel")) === "now",
    );
    const pickFail = await page.textContent('#now .step[data-step="pick"] .inlinefail').catch(() => "");
    check(
      "the picker's failure sits in the Pick step",
      /not signed in/.test(pickFail),
      pickFail.slice(0, 80),
    );
    check(
      "the heuristic's pick is marked as such",
      /heuristic stands in/.test(await page.textContent('#now .step[data-step="pick"] .sum')),
    );
    const frag = await page.getAttribute("#now .pickvideo", "src").catch(() => null);
    check("the pick previews as a #t=start,end window", /#t=391,432$/.test(frag ?? ""), String(frag));
    await page.click('#now [data-act="pick-again"]');
    await page.waitForTimeout(300);
    check("Pick again asks the picker", posts.includes(a), posts.join(","));

    check(
      "the Short hook is prefilled with the model's suggestion",
      (await page.inputValue("#shorthook")) === "DECIDED BY 1.5 SECONDS",
    );
    check("the title hook is prefilled", (await page.inputValue("#hook")).length > 0);
    await page.click('#now .chips[data-for="shorthook"] .chip >> nth=1');
    check("a chip fills the Short hook", (await page.inputValue("#shorthook")) === "A SUB-8 TO WIN IT");
    check("typed is not saved, and says so", /not saved/.test(await page.textContent("#savedmsg")));
    check(
      "the button says what it does",
      (await page.textContent("#save")).trim() === "Save hooks and schedule",
    );

    await page.click("#save");
    await page.waitForFunction(
      () => /^saved\b/.test(document.querySelector("#savedmsg")?.textContent ?? ""),
      null,
      {
        timeout: 10000,
      },
    );
    const put = puts.find((p) => p.id === a);
    check(
      "Save sends both hooks",
      put && put.body.shortHook === "A SUB-8 TO WIN IT" && put.body.titleHook.length > 0 && !put.body.noShort,
      JSON.stringify(put?.body),
    );
    check(
      "the saved hooks fold to one line",
      !(await page.$eval('#now .step[data-step="hooks"]', (s) => s.classList.contains("open"))),
    );
    await page.waitForFunction(
      () => /Next waiting/.test(document.querySelector("#save")?.textContent ?? ""),
      null,
      {
        timeout: 10000,
      },
    );
    await page.click("#save");
    await page.waitForFunction((id) => selected === id, b, { timeout: 10000 });
    check("Next waiting opens the other match", true);

    // no Short for this one
    await page.waitForSelector("#noshort", { timeout: 30000 });
    await page.check("#noshort");
    check("No Short disables the Short hook", await page.$eval("#shorthook", (f) => f.disabled));
    await page.click("#save");
    await page.waitForTimeout(500);
    const put2 = puts.find((p) => p.id === b);
    check(
      "and saves a title hook alone",
      put2 && put2.body.noShort === true && put2.body.shortHook === null,
      JSON.stringify(put2?.body),
    );

    // a weak sync says so on the button
    plans[a] = plan(a, { syncWeak: true });
    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector("#save:not([hidden])", { timeout: 30000 });
    check(
      "a weak sync changes the button",
      (await page.textContent("#save")).trim() === "Sync looks right — save hooks and schedule",
    );
    check(
      "and opens the Video step",
      await page.$eval('#now .step[data-step="video"]', (s) => s.classList.contains("open")),
    );

    // a failed upload: the error under Video up, Retry saves the saved hooks again
    plans[a] = plan(a, {
      titleHook: "A sub-8 to win it",
      shortHook: "A SUB-8 TO WIN IT",
      state: "failed",
      errors: [
        { step: "upload-video", at: new Date().toISOString(), message: "YouTube said 403 quotaExceeded" },
      ],
      log: [
        {
          at: new Date(Date.now() - 60e3).toISOString(),
          step: "upload-video",
          level: "info",
          text: "uploading final.mp4 (745 MiB)",
        },
        {
          at: new Date().toISOString(),
          step: "upload-video",
          level: "error",
          text: "YouTube refused the upload: quotaExceeded",
          detail: '{ "error": { "code": 403, "errors": [{ "reason": "quotaExceeded" }] } }',
        },
      ],
    });
    puts.length = 0;
    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector('#now .step[data-step="videoup"] .inlinefail', { timeout: 30000 });
    check(
      "a failed upload reports under Video up",
      /quotaExceeded/.test(await page.textContent('#now .step[data-step="videoup"]')),
    );
    check(
      "with the fix beside it",
      /quota resets at midnight Pacific/.test(
        await page.textContent('#now .step[data-step="videoup"] .inlinefail .fix'),
      ),
    );
    const fold = '#now .step[data-step="videoup"] .steplog';
    check(
      "its Details fold counts the lines",
      /2 lines · 1 error/.test(await page.textContent(`${fold} > summary`)),
    );
    await page.click(`${fold} > summary`);
    await page.click(`${fold} .logline.lv-error > summary`);
    check("a line unfolds to the server's detail", await page.isVisible(`${fold} .logline.lv-error pre`));
    await page.click(`${fold} [data-act="copy-log"]`);
    // copyText is async: read once the button has answered, or a loaded box reads an empty clipboard.
    await page
      .waitForFunction(
        (sel) => document.querySelector(sel)?.textContent !== "Copy",
        `${fold} [data-act="copy-log"]`,
        {
          timeout: 5000,
        },
      )
      .catch(() => {});
    // Read the label before the clipboard: pasting it back takes a moment on a busy box, and the
    // button returns to "Copy" after 2 s (a flake on 24 Sept, with the copy itself correct).
    const copyLabel = await page.textContent(`${fold} [data-act="copy-log"]`);
    const copied = await readClipboard(page);
    check(
      "Copy puts every line, with its detail, on the clipboard",
      /INFO \[upload-video\] uploading final\.mp4/.test(copied) && /"reason": "quotaExceeded"/.test(copied),
      copied.slice(0, 160),
    );
    check("and says so", /Copied/.test(copyLabel), copyLabel);
    await page.click('#now .step[data-step="videoup"] [data-act="retry"]');
    await page.waitForTimeout(500);
    check(
      "Retry re-saves the saved hooks",
      puts[0]?.body.titleHook === "A sub-8 to win it",
      JSON.stringify(puts[0]?.body),
    );

    // uploads off on the box: the chain stopped after the render on purpose -- not a Retry,
    // Publish is the way (the contract says it as "failed" plus the detail)
    plans[a] = plan(a, {
      titleHook: "A sub-8 to win it",
      shortHook: "A SUB-8 TO WIN IT",
      state: "failed",
      detail:
        "uploads are off (youtubeUploadEnabled / nightlyUpload) — the Short is rendered; Publish is the way",
    });
    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector('#now .step[data-step="videoup"].s-warn', { timeout: 30000 });
    const off = await page.textContent('#now .step[data-step="videoup"]');
    check(
      "uploads off says so under Video up, with Publish and no Retry",
      /uploads are off/.test(off) && /Publish/.test(off) && !(await page.$('#now [data-act="retry"]')),
      off.replace(/\s+/g, " ").trim(),
    );

    // a hook with a " | " in it: the prefill reads up to the name pair
    check(
      "the title's hook is read up to the name pair",
      await page.evaluate(
        () =>
          hookOfTitle(
            "PLAYOFFS | SWEPT vs TAS | A vs B | Playoffs | Round of 16",
            "A vs B | Playoffs | Round of 16",
          ) === "PLAYOFFS | SWEPT vs TAS" && hookOfTitle("<HOOK> | A vs B | x", "A vs B | x") === null,
      ),
    );

    // on the channel: the hooks lock, and say why
    plans[a] = plan(a, {
      titleHook: "A sub-8 to win it",
      shortHook: "A SUB-8 TO WIN IT",
      state: "scheduled",
      uploads: {
        video: { videoId: "aBcDeFgHiJk", publishAt: new Date(Date.now() + 86400e3).toISOString() },
        short: { videoId: "kLmNoPqRsTu", publishAt: new Date(Date.now() + 2 * 86400e3).toISOString() },
      },
    });
    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector('#now .step[data-step="videoup"].s-done', { timeout: 30000 });
    check("the hooks lock once the video is up", await page.$eval("#hook", (f) => f.disabled));
    check("and say why", /re-upload/.test(await page.textContent('#now .step[data-step="hooks"]')));

    // the dashboard gone: the open match says so under its head, the strip on every screen
    plans[a] = {
      ...plans[a],
      state: "rendering",
      activity: { step: "render", line: "encoding the Short", since: new Date().toISOString(), percent: 10 },
    };
    await page.evaluate((id) => select(id, { open: true }), a);
    await page.waitForSelector('#now .step[data-step="short"].s-run', { timeout: 30000 });
    await page.route("**/api/**", (r) => r.abort());
    await page.waitForSelector("#now .nowconn", { timeout: 15000 }).catch(() => {});
    check(
      "a failed poll says the dashboard is unreachable, in Now",
      /dashboard unreachable — retrying/.test(
        (await page.textContent("#now .nowconn").catch(() => "")) ?? "",
      ),
    );
    check("and in the strip", /Dashboard unreachable since/.test(await page.textContent("#nightly")));
    await page.unroute("**/api/**");
    await page
      .waitForFunction(
        () =>
          !document.querySelector("#now .nowconn") &&
          !/unreachable/.test(document.querySelector("#nightly").textContent),
        null,
        { timeout: 15000 },
      )
      .catch(() => {});
    check(
      "both lines go once it answers",
      !(await page.$("#now .nowconn")) && !/unreachable/.test(await page.textContent("#nightly")),
    );

    // what the flow retired
    check(
      "no moments list, no Cut buttons, no burns-in line",
      (await page.$$("#detail .moment, #cuthere, #short")).length === 0 &&
        !/burns in/.test(await page.textContent("#detail")),
    );
    check("the title fold has its own Save text", (await page.$("#savetext")) !== null);
    check("no page errors (desktop)", errors.length === 0, errors.join(" | "));
    // A /api/matches poll can be mid-fetch in its route handler; closing under it threw
    // "Request context disposed" and killed the run before the phone half.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();

    // --- phone ---------------------------------------------------------------------------------
    plans[a] = plan(a);
    plans[b] = plan(b);
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const phone = await ctx.newPage();
    await wire(phone);
    await phone.goto(base + "/", { waitUntil: "networkidle" });
    await phone.evaluate((id) => select(id, { open: true }), a);
    await phone.waitForSelector("#save:not([hidden])", { timeout: 30000 });
    const vh = phone.viewportSize().height;
    const save = await phone.$eval("#save", (e) => e.getBoundingClientRect().toJSON());
    const bar = await phone.$eval("#detail .jump", (e) => e.getBoundingClientRect().toJSON());
    check(
      "the primary button sits in the bottom slot, above the section bar",
      save.bottom <= bar.top + 1 && save.top > vh - 140 && save.height >= 44,
      `save ${Math.round(save.top)}-${Math.round(save.bottom)} bar@${Math.round(bar.top)} vh ${vh}`,
    );
    const links = await phone.$$eval("#detail .jump a", (n) => n.map((x) => x.dataset.panel).join(" "));
    check("the bar is Now, Check, Package, Publish", links === "now check package publish", links);
    // Every other row waiting for a hook with a pick to glance at: the two above, and whatever the
    // server's own list adds. "not picked yet" is backlog, not waiting (awaitsHooks, app.js).
    const others = await phone.evaluate(
      () =>
        matches.filter(
          (m) =>
            !m.hidden &&
            m.shortState === "waiting-for-hook" &&
            m.shortDetail !== "not picked yet" &&
            m.matchId !== selected,
        ).length,
    );
    const more = await phone.$eval("#nextwaiting", (e) => (e.checkVisibility() ? e.textContent : ""));
    check(
      "the back bar offers the next match waiting",
      others >= 1 && more === `${others} more waiting ›`,
      more,
    );
    const toggles = await phone.$$eval("#now .steptoggle", (n) =>
      Math.min(...n.map((e) => e.getBoundingClientRect().height)),
    );
    check("step rows are thumb-sized", toggles >= 44, `${toggles}px`);
    check("no page errors (phone)", errors.length === 0, errors.join(" | "));
    await phone.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
  } finally {
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
