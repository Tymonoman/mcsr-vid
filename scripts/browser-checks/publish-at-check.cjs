const { chromium, readClipboard } = require("./launch.cjs");
const { firefox } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

/* The Publish kit's publish time, typed the way the operator types it — in Firefox as well as
   Chromium (26 Sept 2026: "on firefox i cant change the upload date. theres just no way to edit
   the input box"), at desktop and phone width, in Europe/Warsaw so local-to-UTC is exercised.
   Usage: node publish-at-check.cjs <base> <unuploaded id> [second id] [scheduled id] [published id] [shots dir]

   Nothing but GETs reaches the server. Every other request the page makes is caught by a
   context-wide route: the publish-time PUT is answered here from a model of the server's answers
   (its refusal texts, the kit it would then serve), anything else is aborted and fails the check.
   The server's side of the round-trip is shortFlow.test.ts's. The plan GET of a match not picked
   yet is aborted too: on a real server it queues a model watch. The log of every non-GET request
   is printed at the end.
   PUBLIC_DIR=<checkout>/public serves the page's scripts and styles from that checkout (still
   GETs, answered in the browser; the HTML stays the server's): a branch's client against a server
   that is still on main. */
(async () => {
  const [base, openId, otherId, scheduledId, publishedId, shots] = process.argv.slice(2);
  let ok = true;
  const check = (n, c, d = "") => {
    console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? " -- " + d : ""}`);
    if (!c) ok = false;
  };
  const rows = (await (await fetch(`${base}/api/matches`)).json()).matches;
  const unpicked = new Set(
    rows.filter((m) => m.shortDetail === "not picked yet").map((m) => String(m.matchId)),
  );
  // 2 October 2026, 21:30 in Warsaw (CEST, +02:00) is 19:30 UTC.
  const TYPED = "2026-10-02T21:30";
  const TYPED_UTC = "2026-10-02T19:30:00.000Z";
  const CLASH = "2026-10-03T21:30";
  const CLASH_UTC = "2026-10-03T19:30:00.000Z";
  const CLASH_LINE =
    "another video is scheduled for that hour (2026-10-03 19:00 UTC) — they would split the browse impressions";
  // 01:30 UTC on 25 Oct is 02:30 CET: the second time Warsaw's clocks read 02:30 that night.
  const DST_UTC = "2026-10-25T01:30:00.000Z";
  /** Every non-GET request any page made: [tag, method, path, what became of it]. */
  const writes = [];
  /** Month, day, year, then the time: Firefox moves on to the hour by itself after a 4-digit year, Chromium needs the Tab. */
  const typeWhen = async (page, name, sel) => {
    // Centred: at a phone's height the kit's field can sit under the fixed bottom bar.
    await page.locator(sel).evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = await page.locator(sel).boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.keyboard.type("10022026");
    if (name === "chromium") await page.keyboard.press("Tab");
    await page.keyboard.type("0930P");
  };
  const tall = async (page, sel) => ((await page.locator(sel).boundingBox())?.height ?? 0) >= 44;
  const idOf = (url) => new URL(url).pathname.split("/").pop();

  // The log is printed whatever happens, a crash included: an unexpected write is always reported.
  try {
    for (const [name, type] of [
      ["chromium", chromium],
      ["firefox", firefox],
    ]) {
      const browser = await type.launch();
      try {
        for (const [vp, viewport] of [
          ["desktop", { width: 1400, height: 1000 }],
          ["phone", { width: 390, height: 844 }],
        ]) {
          const tag = `${name} ${vp}`;
          const ctx = await browser.newContext({
            viewport,
            locale: "en-US",
            timezoneId: "Europe/Warsaw",
            hasTouch: vp === "phone",
          });
          // The guard: GET and HEAD go to the server, nothing else does. The page routes below take
          // precedence and answer the publish-time PUT; whatever reaches this handler is aborted.
          await ctx.route("**/*", (route) => {
            const req = route.request();
            if (req.method() === "GET" || req.method() === "HEAD") {
              const p = new URL(req.url()).pathname;
              // Not the document: one fulfilled here has no address, and Chromium then blocks its
              // fetches to a private-network server (Private Network Access).
              const local =
                process.env.PUBLIC_DIR &&
                req.resourceType() !== "document" &&
                path.join(process.env.PUBLIC_DIR, p);
              if (local && !p.startsWith("/api/") && fs.existsSync(local) && fs.statSync(local).isFile())
                return route.fulfill({ path: local });
              return route.continue();
            }
            writes.push([tag, req.method(), new URL(req.url()).pathname, "ABORTED"]);
            return route.abort();
          });
          const page = await ctx.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));

          /* --- The server, as far as the publish time goes ------------------------------------ */
          /** A match's `publish` after a stubbed save; absent, the kit as the server serves it. */
          const held = new Map();
          /** Per id, a change to the served kit (a scheduled state on a match that is not). */
          const shape = new Map();
          const served = new Map();
          const kitGets = [];
          const sent = [];
          let hold = null;
          await page.route("**/api/publishkit/*", async (route) => {
            const id = idOf(route.request().url());
            kitGets.push(id);
            const res = await route.fetch();
            let kit = await res.json();
            served.set(id, kit.publish);
            kit = shape.get(id)?.(kit) ?? kit;
            if (held.has(id)) kit = { ...kit, publish: held.get(id), publishAt: held.get(id).at };
            return route.fulfill({ response: res, json: kit });
          });
          await page.route("**/api/shorts/publishat/*", async (route) => {
            const id = idOf(route.request().url());
            const body = JSON.parse(route.request().postData() ?? "{}");
            writes.push([tag, "PUT", new URL(route.request().url()).pathname, "answered in the browser"]);
            sent.push({ id, body });
            if (hold) await hold;
            const answer = (status, json) => route.fulfill({ status, json });
            const view = (over) => ({ state: "open", chosen: true, why: null, warnings: [], ...over });
            if (body.move) {
              held.set(id, view({ state: "scheduled", at: body.publishAt, chosen: false }));
              return answer(200, {
                publishAt: body.publishAt,
                message: "YouTube has it (stubbed in the browser)",
                warnings: [],
              });
            }
            if (body.publishAt === null) {
              const s = served.get(id);
              held.set(id, view({ chosen: false, at: s && !s.chosen ? s.at : "2026-10-01T19:00:00.000Z" }));
              return answer(200, { publishAt: null });
            }
            const ms = Date.parse(body.publishAt);
            if (ms <= Date.now())
              return answer(400, { error: "that time has passed — pick one in the future" });
            const warnings = body.publishAt === CLASH_UTC ? [CLASH_LINE] : [];
            held.set(id, view({ at: body.publishAt, warnings }));
            return answer(200, { publishAt: body.publishAt, warnings });
          });
          // The by-hand upload form, whose #ytWhen follows the kit's time: drawn as if uploads were on
          // (and, on a test server with no token, as if the channel were connected).
          await page.route("**/api/youtube/status", async (route) => {
            const res = await route.fetch();
            return route.fulfill({
              response: res,
              json: { ...(await res.json()), connected: true, uploadsEnabled: true },
            });
          });
          await page.route("**/api/shorts/plan/*", (route) =>
            unpicked.has(idOf(route.request().url())) ? route.abort() : route.fallback(),
          );

          const toPublish = async () => {
            if (vp === "phone") {
              await page.waitForSelector('#detail .jump a[data-panel="publish"]', { timeout: 30000 });
              await page.click('#detail .jump a[data-panel="publish"]');
            }
            await page.waitForSelector("#publishkit .kit", { timeout: 30000 });
          };
          const open = async (id) => {
            await page.goto(base + "/", { waitUntil: "networkidle" });
            await page.evaluate((id) => select(Number(id), { open: true }), id);
            await toPublish();
          };
          const msg = () => page.locator("#kitWhenMsg").innerText();
          const kitBlock = "#publishkit .kit:has(#kitWhen)";
          const shot = async (what) => {
            if (shots)
              await page
                .locator(kitBlock)
                .screenshot({ path: `${shots}/publish-at-${name}-${vp}-${what}.png` });
          };

          /* --- Not uploaded: type a time, save it, see it come back, clear it ------------------ */
          await open(openId);
          const field = page.locator("#kitWhen");
          check(
            `${tag}: the field is there and editable`,
            (await field.count()) === 1 && (await field.isEditable()),
          );
          if (vp === "phone") {
            check(`${tag}: the field is a 44 px target`, await tall(page, "#kitWhen"));
            check(`${tag}: Save is a 44 px target`, await tall(page, "#kitWhenSave"));
          }
          const shown = await field.inputValue();
          await typeWhen(page, name, "#kitWhen");
          check(
            `${tag}: typing changes the field`,
            (await field.inputValue()) === TYPED,
            `${shown} -> ${await field.inputValue()}`,
          );
          check(
            `${tag}: it says the instant in UTC, not saved`,
            (await msg()) === "not saved — 2026-10-02 19:30 UTC",
            await msg(),
          );
          await shot("typed");
          await page.click("#kitWhenSave");
          await page.waitForFunction(
            () => /saved —/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            null,
            {
              timeout: 15000,
            },
          );
          check(
            `${tag}: Save sends it in UTC`,
            JSON.stringify(sent.at(-1)?.body) === JSON.stringify({ publishAt: TYPED_UTC }),
            JSON.stringify(sent.at(-1)),
          );
          check(`${tag}: the field shows the saved time`, (await field.inputValue()) === TYPED);
          const line = await page.locator(`${kitBlock} textarea`).inputValue();
          check(
            `${tag}: the copy line names it with UTC beside`,
            /Oct 2.*09:30 PM \(19:30 UTC\)/.test(line),
            line,
          );
          const ytWhen = page.locator("#ytWhen");
          if ((await ytWhen.count()) === 0)
            console.log(`SKIP ${tag}: the by-hand form -- ${openId} has no upload form`);
          else
            check(
              `${tag}: the by-hand upload form follows the saved time`,
              (await ytWhen.inputValue()) === TYPED,
              await ytWhen.inputValue(),
            );
          await page.locator(`${kitBlock} button.copy`).click();
          await page.waitForTimeout(300);
          check(`${tag}: Copy still copies the line`, (await readClipboard(page)) === line);
          // Back from a reload: what the (stubbed) server now serves.
          await open(openId);
          check(
            `${tag}: after a reload the field holds it`,
            (await page.locator("#kitWhen").inputValue()) === TYPED,
          );
          check(
            `${tag}: and says it is the operator's`,
            /your time/.test(await page.locator(`${kitBlock} .kithead`).innerText()),
          );
          await shot("saved");
          if (vp === "desktop") {
            // Now's Video up names the chosen time (a playoff game before its join has no steps).
            if (unpicked.has(String(openId))) console.log(`SKIP ${tag}: Now -- ${openId} is not picked yet`);
            else {
              await page.waitForSelector("#now .step, #now .seriesnote", { timeout: 30000 });
              const now = await page.locator("#now").innerText();
              if ((await page.locator("#now .step").count()) === 0)
                console.log(`SKIP ${tag}: Now -- ${openId} is a playoff game, uploaded from game 1`);
              else
                check(
                  `${tag}: Now's Video up names it`,
                  /Oct 2.*09:30 PM.*your time/i.test(now),
                  now.match(/Video up[^\n]*\n?[^\n]*/)?.[0],
                );
            }
          }
          // A time in the past is refused with a plain line under the button.
          await page.locator("#kitWhen").fill("2020-01-01T10:00");
          await page.click("#kitWhenSave");
          await page.waitForSelector(".kit .inlinefail", { timeout: 10000 });
          check(
            `${tag}: the past is refused`,
            /has passed/.test(await page.locator(".kit .inlinefail").innerText()),
          );
          // The slot rules are warnings: an hour another video holds still saves, and says so.
          await page.locator("#kitWhen").fill(CLASH);
          await page.click("#kitWhenSave");
          await page.waitForSelector("#publishkit .kitwarn", { timeout: 15000 });
          check(
            `${tag}: a taken hour saves with a warning`,
            sent.at(-1)?.body.publishAt === CLASH_UTC &&
              (await page.locator("#publishkit .kitwarn").first().innerText()) === `! ${CLASH_LINE}`,
            await page.locator("#publishkit .kitwarn").first().innerText(),
          );
          await shot("warned");
          await page.click("#kitWhenFree");
          await page.waitForFunction(
            () => /next free slot/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            null,
            {
              timeout: 15000,
            },
          );
          check(
            `${tag}: "use the next free slot" sends null`,
            JSON.stringify(sent.at(-1)?.body) === JSON.stringify({ publishAt: null }),
          );
          check(
            `${tag}: and the field shows the slot`,
            (await page.locator("#kitWhen").inputValue()) !== CLASH.slice(0, 16),
          );

          /* --- The hour Warsaw lives twice: the kit's own instant is sent back, not re-parsed ------ */
          held.set(String(openId), { state: "open", at: DST_UTC, chosen: true, why: null, warnings: [] });
          await open(openId);
          check(
            `${tag}: 01:30 UTC shows as 02:30`,
            (await field.inputValue()) === "2026-10-25T02:30",
            await field.inputValue(),
          );
          await page.click("#kitWhenSave");
          await page.waitForFunction(
            () => /saved —/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            null,
            {
              timeout: 15000,
            },
          );
          check(
            `${tag}: Save untouched keeps that instant`,
            sent.at(-1)?.body.publishAt === DST_UTC,
            JSON.stringify(sent.at(-1)?.body),
          );
          await field.fill("2026-10-25T02:30");
          check(
            `${tag}: typed, it says which 02:30 it takes`,
            (await msg()) === "not saved — 2026-10-25 00:30 UTC",
            await msg(),
          );

          /* --- Scheduled on YouTube: the button says it moves it there ---------------------------- */
          const schedId = String(scheduledId || otherId || "");
          if (schedId) {
            shape.set(schedId, (kit) =>
              kit.publish?.state === "scheduled"
                ? kit
                : {
                    ...kit,
                    publish: {
                      state: "scheduled",
                      at: "2026-10-01T19:00:00.000Z",
                      chosen: false,
                      why: null,
                      warnings: [],
                    },
                  },
            );
            await open(schedId);
            const btn = page.locator("#kitWhenSave");
            check(
              `${tag}: a scheduled video's button moves it`,
              /^Move on YouTube to /.test(await btn.innerText()),
              await btn.innerText(),
            );
            await typeWhen(page, name, "#kitWhen");
            check(
              `${tag}: typing renames the button`,
              /Oct 2.*09:30 PM/.test(await btn.innerText()),
              await btn.innerText(),
            );
            await shot("scheduled");
            await btn.click();
            await page.waitForFunction(
              () => /stubbed/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
              null,
              {
                timeout: 15000,
              },
            );
            check(
              `${tag}: the press asks for the move, in UTC`,
              JSON.stringify(sent.at(-1)) ===
                JSON.stringify({ id: schedId, body: { publishAt: TYPED_UTC, move: true } }),
              JSON.stringify(sent.at(-1)),
            );
          } else console.log(`SKIP ${tag}: Move -- no second match`);

          /* --- Published: a copy block, nothing to edit ------------------------------------------- */
          if (publishedId) {
            await open(publishedId);
            check(`${tag}: a published video has no field`, (await page.locator("#kitWhen").count()) === 0);
            const kit = page.locator('#publishkit .kit:has(.kitlabel:text-is("Publish at")) textarea');
            check(
              `${tag}: it says published`,
              /^published /.test(await kit.inputValue()),
              await kit.inputValue(),
            );
          }

          /* --- A press still in flight when another match is opened paints nothing there --------- */
          if (otherId && String(otherId) !== String(openId)) {
            held.delete(String(openId));
            shape.delete(String(otherId));
            await open(openId);
            let release;
            hold = new Promise((r) => (release = r));
            await page.locator("#kitWhen").fill(TYPED);
            await page.click("#kitWhenSave");
            await page.waitForFunction(() =>
              /saving/.test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
            );
            await page.evaluate((id) => select(Number(id), { open: true }), otherId);
            await toPublish();
            const before = kitGets.filter((id) => id === String(openId)).length;
            release();
            hold = null;
            await page.waitForTimeout(1500);
            check(
              `${tag}: the old match's kit is not fetched again`,
              kitGets.filter((id) => id === String(openId)).length === before,
            );
            check(
              `${tag}: nor its "saved" line shown on the new match`,
              !/saved/.test(await msg()),
              await msg(),
            );
          }

          check(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
          await ctx.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    console.log(`\nEvery non-GET request the pages made (${writes.length}):`);
    for (const [tag, method, p, fate] of writes) console.log(`  ${tag}: ${method} ${p} -- ${fate}`);
    // By construction none reached the server (the guard lets only GET and HEAD through); one the
    // stubs did not expect was aborted, and fails here.
    const unexpected = writes.filter((w) => w[3] !== "answered in the browser");
    check(
      "every write request was answered in the browser, none reached the server",
      unexpected.length === 0,
      unexpected.map((w) => w.join(" ")).join(" | "),
    );
  }

  process.exitCode = ok ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
