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
   The server's side of the round-trip is shortFlow.test.ts's. The plan GET of an exported match
   not on the channel is aborted too unless its row names the pick's window: on a real server it
   can queue a model watch. The log of every non-GET request is printed at the end. The dates are
   worked out from today, so the check does not expire.
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
  // Opening an exported match with no pick that is not on the channel queues a model watch
  // (shortPlan); a row whose detail names the pick's window ("Short 6:21–7:02, …") has one.
  const noPlan = new Set(
    rows
      .filter((m) => m.exported && !m.uploaded && !/^Short (game \d+ )?\d+:\d\d–/.test(m.shortDetail ?? ""))
      .map((m) => String(m.matchId)),
  );
  const DAY = 864e5;
  const utcLine = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  /** An instant on Warsaw's clock, as a datetime-local value. */
  const warsaw = (iso) =>
    new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Warsaw" }).slice(0, 16).replace(" ", "T");
  // A week from today at 19:30 UTC, and the day after: what the page shows for them, worked out
  // here in Warsaw's zone the way the page does it in the browser's.
  const TYPED_UTC = new Date((Math.floor(Date.now() / DAY) + 7) * DAY + 19.5 * 3600e3).toISOString();
  const TYPED = warsaw(TYPED_UTC);
  const CLASH_UTC = new Date(Date.parse(TYPED_UTC) + DAY).toISOString();
  const CLASH = warsaw(CLASH_UTC);
  const CLASH_LINE = `another video is scheduled for that hour (${CLASH_UTC.slice(0, 10)} 19:00 UTC) — they would split the browse impressions`;
  /** A stand-in slot or scheduled time, some days out. */
  const slotIn = (days) => new Date((Math.floor(Date.now() / DAY) + days) * DAY + 19 * 3600e3).toISOString();
  const hour = Number(TYPED.slice(11, 13));
  const h12 = String(((hour + 11) % 12) + 1).padStart(2, "0");
  const month = new Date(TYPED_UTC).toLocaleString("en-US", { timeZone: "Europe/Warsaw", month: "short" });
  /** "Oct 3 … 09:30 PM", however the browser spaces the AM/PM. */
  const SHOWN = `${month} ${Number(TYPED.slice(8, 10))}\\b.*${h12}:${TYPED.slice(14)}\\s${hour < 12 ? "AM" : "PM"}`;
  // Warsaw's clocks go back at 01:00 UTC on the last Sunday of October, so 02:00–02:59 happens
  // twice: 01:30 UTC is the second 02:30, and a typed 02:30 is the first (00:30 UTC). The next
  // such night still ahead.
  const lastSundayOfOct = (y) => {
    const d = new Date(Date.UTC(y, 9, 31));
    return new Date(d.getTime() - d.getUTCDay() * DAY).toISOString().slice(0, 10);
  };
  let dstYear = new Date().getUTCFullYear();
  if (Date.parse(`${lastSundayOfOct(dstYear)}T01:30:00Z`) < Date.now() + 2 * 3600e3) dstYear++;
  const DST_DAY = lastSundayOfOct(dstYear);
  const DST_UTC = `${DST_DAY}T01:30:00.000Z`;
  const DST_FIRST_UTC = `${DST_DAY}T00:30:00.000Z`;
  /** Every non-GET request any page made: [tag, method, path, what became of it]. */
  const writes = [];
  /** Month, day, year, then the time: Firefox moves on to the hour by itself after a 4-digit year, Chromium needs the Tab. */
  const typeWhen = async (page, name, sel) => {
    // Centred: at a phone's height the kit's field can sit under the fixed bottom bar.
    await page.locator(sel).evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = await page.locator(sel).boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.keyboard.type(`${TYPED.slice(5, 7)}${TYPED.slice(8, 10)}${TYPED.slice(0, 4)}`);
    if (name === "chromium") await page.keyboard.press("Tab");
    await page.keyboard.type(`${h12}${TYPED.slice(14)}${hour < 12 ? "A" : "P"}`);
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
          /** { id, gate }: that match's kit GETs wait for the gate. */
          let holdKit = null;
          await page.route("**/api/publishkit/*", async (route) => {
            const id = idOf(route.request().url());
            kitGets.push(id);
            if (holdKit?.id === id) await holdKit.gate;
            // Held, it may outlive its page: a closed context is not a failure of the check.
            const res = await route.fetch().catch(() => null);
            if (!res) return;
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
            const view = (over) => ({
              state: "open",
              chosen: true,
              stored: true,
              why: null,
              warnings: [],
              ...over,
            });
            if (body.move) {
              held.set(id, view({ state: "scheduled", at: body.publishAt, chosen: false, stored: false }));
              return answer(200, {
                publishAt: body.publishAt,
                message: "YouTube has it (stubbed in the browser)",
                warnings: [],
              });
            }
            if (body.publishAt === null) {
              const s = served.get(id);
              held.set(id, view({ chosen: false, stored: false, at: s && !s.chosen ? s.at : slotIn(5) }));
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
            noPlan.has(idOf(route.request().url())) ? route.abort() : route.fallback(),
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
          /** Until the line beside Save matches. */
          const waitMsg = (re) =>
            page.waitForFunction(
              (src) => new RegExp(src).test(document.querySelector("#kitWhenMsg")?.textContent ?? ""),
              re.source,
              { timeout: 15000 },
            );
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
            (await msg()) === `not saved — ${utcLine(TYPED_UTC)}`,
            await msg(),
          );
          await shot("typed");
          // Held in flight: the button is off until the answer, so a second press sends nothing.
          let answer;
          hold = new Promise((r) => (answer = r));
          await page.click("#kitWhenSave");
          await waitMsg(/saving/);
          const inFlight = sent.length;
          check(`${tag}: Save is off while it is sent`, await page.locator("#kitWhenSave").isDisabled());
          await page
            .locator("#kitWhenSave")
            .click({ force: true, timeout: 2000 })
            .catch(() => {});
          await page.waitForTimeout(300);
          check(
            `${tag}: a second press mid-flight sends nothing`,
            sent.length === inFlight,
            `${sent.length - inFlight} more`,
          );
          answer();
          hold = null;
          await waitMsg(/saved —/);
          check(
            `${tag}: Save sends it in UTC`,
            JSON.stringify(sent.at(-1)?.body) === JSON.stringify({ publishAt: TYPED_UTC }),
            JSON.stringify(sent.at(-1)),
          );
          check(`${tag}: the field shows the saved time`, (await field.inputValue()) === TYPED);
          const line = await page.locator(`${kitBlock} textarea`).inputValue();
          check(
            `${tag}: the copy line names it with UTC beside`,
            new RegExp(`${SHOWN} \\(${TYPED_UTC.slice(11, 16)} UTC\\)`).test(line),
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
            if (noPlan.has(String(openId)))
              console.log(`SKIP ${tag}: Now -- ${openId}'s plan is not fetched`);
            else {
              await page.waitForSelector("#now .step, #now .seriesnote", { timeout: 30000 });
              const now = await page.locator("#now").innerText();
              if ((await page.locator("#now .step").count()) === 0)
                console.log(`SKIP ${tag}: Now -- ${openId} is a playoff game, uploaded from game 1`);
              else
                check(
                  `${tag}: Now's Video up names it`,
                  new RegExp(`${SHOWN}.*your time`, "i").test(now),
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
          await waitMsg(/next free slot/);
          check(
            `${tag}: "use the next free slot" sends null`,
            JSON.stringify(sent.at(-1)?.body) === JSON.stringify({ publishAt: null }),
          );
          check(
            `${tag}: and the field shows the slot`,
            (await page.locator("#kitWhen").inputValue()) !== CLASH.slice(0, 16),
          );

          /* --- The hour Warsaw lives twice: the kit's own instant is sent back, not re-parsed ------ */
          held.set(String(openId), {
            state: "open",
            at: DST_UTC,
            chosen: true,
            stored: true,
            why: null,
            warnings: [],
          });
          await open(openId);
          check(
            `${tag}: 01:30 UTC shows as 02:30`,
            (await field.inputValue()) === `${DST_DAY}T02:30`,
            await field.inputValue(),
          );
          await page.click("#kitWhenSave");
          await waitMsg(/saved —/);
          check(
            `${tag}: Save untouched keeps that instant`,
            sent.at(-1)?.body.publishAt === DST_UTC,
            JSON.stringify(sent.at(-1)?.body),
          );
          // Typed back to what it showed: the hint says the first 02:30, and Save sends what it says.
          await field.fill(`${DST_DAY}T03:30`);
          await field.fill(`${DST_DAY}T02:30`);
          check(
            `${tag}: typed, it says which 02:30 it takes`,
            (await msg()) === `not saved — ${utcLine(DST_FIRST_UTC)}`,
            await msg(),
          );
          await page.click("#kitWhenSave");
          await waitMsg(/saved —/);
          check(
            `${tag}: and Save sends that one`,
            sent.at(-1)?.body.publishAt === DST_FIRST_UTC,
            JSON.stringify(sent.at(-1)?.body),
          );

          /* --- A stored time that has passed can still be cleared ------------------------------ */
          held.set(String(openId), {
            state: "open",
            at: slotIn(2),
            chosen: false,
            stored: true,
            why: "your time had passed — the next free slot instead (stubbed)",
            warnings: [],
          });
          await open(openId);
          check(
            `${tag}: a passed time offers "use the next free slot"`,
            (await page.locator("#kitWhenFree").count()) === 1,
          );

          /* --- Scheduled from Studio, no record here: a line, nothing to press ---------------- */
          held.set(String(openId), {
            state: "studio",
            at: slotIn(3),
            chosen: false,
            stored: false,
            why: null,
            warnings: [],
          });
          await open(openId);
          const studioLine = await page
            .locator('#publishkit .kit:has(.kitlabel:text-is("Publish at")) textarea')
            .inputValue();
          check(
            `${tag}: a Studio upload says move it there, with no field`,
            (await page.locator("#kitWhen").count()) === 0 &&
              /uploaded in Studio: move it there$/.test(studioLine),
            studioLine,
          );
          held.delete(String(openId));

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
                      at: slotIn(5),
                      chosen: false,
                      stored: false,
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
              new RegExp(SHOWN).test(await btn.innerText()),
              await btn.innerText(),
            );
            await shot("scheduled");
            await btn.click();
            await waitMsg(/stubbed/);
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
            await waitMsg(/saving/);
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

          /* --- A kit still on its way when another match opens wires nothing into that one ------ */
          // Held until the other match's kit is painted: before r2 #2 its handlers landed on the
          // other match's field, and a Save there PUT for both — a Move of a live video included.
          if (otherId && String(otherId) !== String(openId)) {
            await page.goto(base + "/", { waitUntil: "networkidle" });
            let releaseKit;
            holdKit = { id: String(openId), gate: new Promise((r) => (releaseKit = r)) };
            await Promise.all([
              page.waitForRequest((r) => r.url().endsWith(`/api/publishkit/${openId}`)),
              page.evaluate((id) => select(Number(id), { open: true }), openId),
            ]);
            await page.evaluate((id) => select(Number(id), { open: true }), otherId);
            await toPublish();
            releaseKit();
            holdKit = null;
            await page.waitForTimeout(1500);
            const before = sent.length;
            await page.locator("#kitWhen").fill(TYPED);
            await page.click("#kitWhenSave");
            await waitMsg(/saved —|stubbed/);
            await page.waitForTimeout(500);
            const after = sent.slice(before);
            check(
              `${tag}: a kit that landed late sends nothing for its match`,
              after.length === 1 && after[0].id === String(otherId),
              JSON.stringify(after),
            );

            // The other way round: this match's kit is late, and its upload form waits for it
            // rather than taking the last match's time.
            await open(openId);
            holdKit = { id: String(otherId), gate: new Promise((r) => (releaseKit = r)) };
            await page.evaluate((id) => select(Number(id), { open: true }), otherId);
            await page.waitForSelector("#ytWhen", { state: "attached", timeout: 30000 });
            check(
              `${tag}: the next match's upload form does not take this one's time`,
              (await page.locator("#ytWhen").inputValue()) === "",
              await page.locator("#ytWhen").inputValue(),
            );
            releaseKit();
            holdKit = null;
            await page.waitForSelector("#publishkit .kit", { state: "attached", timeout: 30000 });
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
