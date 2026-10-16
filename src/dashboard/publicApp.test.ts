// public/app.js in a real browser, against an in-process stand-in for the dashboard's API: the
// page's own code and its own repaints, which is where these went wrong, and no fixture capture or
// live server needed. What is pinned:
//   - the PLAYOFFS fold stays open across renderSuggestions' repaints (the series poll's every
//     15 s among them), and stays shut once shut;
//   - the strip never tells the operator to `docker restart` (a hand restart mid-upload cut the
//     1 Oct upload at 30%): it names restart-when-idle, and nothing once that is armed;
//   - hand mode (shortsByHand) offers no Pick again (the route answers 409) and never promises an
//     automatic render of the Short;
//   - any Settings save re-reads Tonight, so a runner just blocked leaves the cards at once.
// Needs Chromium (`npx playwright install chromium`): a box without it skips out loud. Drives a
// browser, so it is one of `npm test`'s extras, not test:unit (CI's runner has none).
// Run: npx tsx src/dashboard/publicApp.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium } from "playwright";

if (!existsSync(chromium.executablePath())) {
  console.log("SKIP: public/app.js in a browser (no Playwright Chromium: npx playwright install chromium)");
  process.exit(0);
}

const PUBLIC = path.join(import.meta.dirname, "..", "..", "public");
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
const card = (matchId: number, a: string, b: string) => ({
  matchId,
  bucket: "close",
  players: [a, b],
  story: "",
  facts: "8:01",
  expiryLabel: "VOD 12d left",
  expiring: false,
  splits: [],
  matchUrl: "https://example.invalid/match",
  vodUrls: [],
});
const now = Math.floor(Date.now() / 1000);
const state = {
  blocked: [] as string[],
  suggestionGets: 0,
  nightly: {
    enabled: true,
    hourUtc: 3,
    nextRunAt: null,
    candidate: null,
    lastRun: null,
    skipTonight: false,
    queue: [],
    nightlySkip: [],
    // One merge ahead of the server, while the chain uploads: the moment a hand restart does harm.
    code: { boot: "aaaaaaa", now: "bbbbbbb" },
    activity: {
      running: [
        {
          step: "upload-video",
          matchId: 1,
          line: "uploading the long-form",
          since: new Date().toISOString(),
          percent: 40,
        },
      ],
      queued: [],
    },
  } as Record<string, unknown>,
};
const settings = () => ({
  fields: [
    {
      key: "blockedPlayers",
      label: "Blocked players",
      help: "",
      kind: "list",
      group: "Suggestions",
      value: state.blocked,
    },
  ],
  readOnly: [],
  nightlyArmedAt: null,
});
const playoffs = {
  season: 11,
  bracketUrl: "https://example.invalid/bracket",
  slots: [
    {
      round: "Final",
      bestOf: 5,
      startTime: now + 3600,
      seeds: [
        { nickname: "alpha", label: "LCQ" },
        { nickname: "beta", label: "LCQ" },
      ],
      games: [{ matchId: 11, gameNo: 1, url: "https://example.invalid/11" }],
      series: {
        firstGameId: 11,
        exported: [true],
        joined: false,
        assembledAt: null,
        shortFromMatchId: null,
        progress: null,
      },
    },
  ],
};

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  if (!p.startsWith("/api/")) {
    const file = path.join(PUBLIC, p === "/" ? "index.html" : p);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  if (p === "/api/stages") return send(res, 200, { order: [], labels: {}, short: {} });
  if (p === "/api/matches") return send(res, 200, { matches: [] });
  if (p === "/api/nightly") return send(res, 200, state.nightly);
  if (p === "/api/playoffs") return send(res, 200, playoffs);
  if (p === "/api/suggestions") {
    state.suggestionGets++;
    // What the server does on every read (suggest.ts, blockedIn): a blocked runner's card is gone.
    const blocked = state.blocked.map((n) => n.toLowerCase());
    const suggestions = [card(1, "alpha", "beta"), card(2, "gamma", "delta")].filter(
      (s) => !s.players.some((n) => blocked.includes(n.toLowerCase())),
    );
    return send(res, 200, { suggestions, scanning: false, scannedAtMs: Date.now(), ttlMin: 30 });
  }
  if (p === "/api/settings" && req.method === "GET") return send(res, 200, settings());
  if (p === "/api/settings" && req.method === "PUT") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const patch = JSON.parse(body) as { blockedPlayers?: string };
      state.blocked = (patch.blockedPlayers ?? "").split(/[\s,]+/).filter(Boolean);
      send(res, 200, { ...settings(), changed: Object.keys(patch) });
    });
    return;
  }
  send(res, 404, { error: `not stubbed: ${req.method} ${p}` });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#playoffs details.playoffsoon", { timeout: 10_000 });
  await page.waitForSelector('#suggestions .sugg[data-id="1"]');

  /* --- The PLAYOFFS fold across repaints ------------------------------------------------- */
  const fold = "#playoffs details.playoffsoon";
  const isOpen = () => page.$eval(fold, (d) => (d as HTMLDetailsElement).open);
  // What the series button and the 15 s series poll call: the cards repaint, then the board.
  const repaint = async () => {
    await page.evaluate(() =>
      (window as unknown as { pollSuggestions: () => Promise<void> }).pollSuggestions(),
    );
    await page.waitForTimeout(300);
  };
  assert.equal(await isOpen(), false, "folded on load");
  await page.click(`${fold} > summary`);
  assert.equal(await isOpen(), true);
  await repaint();
  assert.equal(await isOpen(), true, "opened, it stays open across a repaint");
  await repaint();
  assert.equal(await isOpen(), true, "and the next");
  await page.click(`${fold} > summary`);
  await repaint();
  assert.equal(await isOpen(), false, "shut again, it stays shut");
  console.log("OK: the PLAYOFFS fold keeps its open state across the strip's repaints");

  /* --- The strip's restart advice ---------------------------------------------------------- */
  const strip = () => page.innerText("#nightly");
  await page.waitForFunction(() =>
    /uploading #1/.test(document.querySelector("#nightly")?.textContent ?? ""),
  );
  let text = await strip();
  assert.ok(/The server is running aaaaaaa; the repo is at bbbbbbb/.test(text), text);
  assert.ok(!/docker restart/.test(text), `never a hand restart, least of all mid-upload: ${text}`);
  assert.ok(/POST \/api\/restart-when-idle/.test(text), text);
  state.nightly.restart = { blockedBy: ["upload"] };
  await page.evaluate(() => (window as unknown as { loadNightly: () => Promise<void> }).loadNightly());
  await page.waitForFunction(() =>
    /restart pending/.test(document.querySelector("#nightly")?.textContent ?? ""),
  );
  text = await strip();
  assert.ok(!/docker restart|restart-when-idle picks/.test(text), `armed: its own line says so: ${text}`);
  assert.ok(/the repo is at bbbbbbb/.test(text), text);
  console.log("OK: the strip names restart-when-idle, never docker restart, and goes quiet once armed");

  /* --- Hand mode on the Now group ---------------------------------------------------------- */
  const plan = (extra: Record<string, unknown>) => ({
    matchId: 1,
    titleHook: null,
    shortHook: null,
    uploads: {},
    state: "waiting-for-hook",
    detail: null,
    activity: null,
    pickActivity: null,
    preview: null,
    suggestions: { title: [], short: [] },
    noShort: false,
    syncWeak: false,
    errors: [],
    log: [],
    pick: {
      gameMatchId: 1,
      startMs: 381_000,
      endMs: 422_000,
      pov: "both",
      focus: "right",
      hookSuggestion: "",
      why: "",
      kind: "race",
      source: "heuristic",
    },
    ...extra,
  });
  const meta = {
    leftNickname: "alpha",
    rightNickname: "beta",
    sync: { confidence: 0.9 },
    title: "",
    hook: null,
  };
  type Step = { key: string; sum: string; body?: string };
  const steps = (p: unknown) =>
    page.evaluate(
      ([p, m]) => (window as unknown as { nowSteps: (p: unknown, m: unknown) => Step[] }).nowSteps(p, m),
      [p, meta] as const,
    );
  const by = (list: Step[], key: string) => list.find((s) => s.key === key)!;

  const auto = await steps(plan({}));
  assert.ok(by(auto, "pick").body!.includes('data-act="pick-again"'), "the model's mode keeps Pick again");
  assert.ok(/renders once the hooks are saved/.test(by(auto, "short").sum));

  const hand = await steps(plan({ shortsByHand: true }));
  const pickBody = by(hand, "pick").body!;
  assert.ok(!pickBody.includes('data-act="pick-again"'), `no button the server always refuses: ${pickBody}`);
  assert.ok(/hint for the hand cut/.test(pickBody), pickBody);
  const shortSum = by(hand, "short").sum;
  assert.ok(!/renders/.test(shortSum) && /short:hand/.test(shortSum), shortSum);
  const savedHand = await steps(plan({ shortsByHand: true, titleHook: "A HOOK" }));
  assert.ok(!/waits for the pick/.test(by(savedHand, "short").sum), by(savedHand, "short").sum);
  const unpicked = await steps(plan({ shortsByHand: true, pick: null }));
  assert.ok(/still runs/.test(by(unpicked, "pick").body!), "ensurePick's own wording");
  assert.ok(!/no model pick is spent/.test(by(unpicked, "pick").body!));

  // The save button with uploads off: the Short is the session's cut, not a render.
  const label = await page.evaluate(
    (p) => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="now"><div class="step open" data-step="hooks"></div></div><div class="row saverow"><button id="save"></button></div><div id="savedmsg"></div>',
      );
      // `let` globals of classic scripts (app.js, youtube.js) are not on window: a global-scope
      // eval reaches them by name.
      (0, eval)("(p) => { nowPlan = p; ytStatus = { connected: false }; paintSave(); }")(p);
      return document.querySelector("#save")!.textContent;
    },
    plan({ shortsByHand: true }),
  );
  assert.ok(label && !/renders the Short/.test(label) && /cut by hand/.test(label), String(label));
  console.log("OK: hand mode offers no Pick again and never promises a rendered Short");

  /* --- A Settings save re-reads Tonight ---------------------------------------------------- */
  await page.click("#tab-settings");
  await page.waitForSelector('#settings [data-key="blockedPlayers"]');
  const gets = state.suggestionGets;
  await page.fill('#settings [data-key="blockedPlayers"]', "Alpha");
  await page.click("#setsave");
  await page.waitForFunction(() => /saved/.test(document.querySelector("#setmsg")?.textContent ?? ""));
  await page.waitForTimeout(500);
  assert.ok(state.suggestionGets > gets, "the save asks for the list again");
  await page.click("#tab-suggestions");
  assert.equal(
    await page.locator('#suggestions .sugg[data-id="1"]').count(),
    0,
    "the blocked runner's card is gone",
  );
  assert.equal(await page.locator('#suggestions .sugg[data-id="2"]').count(), 1, "the rest stay");
  console.log("OK: blocking a runner in Settings takes their card off Tonight without a reload");

  assert.deepEqual(errors, [], "no page errors");
} finally {
  await browser.close();
  server.close();
}
console.log("publicApp: all checks passed");
