// A stand-in dashboard for the browser checks: serves public/ from this checkout and answers the
// API from fixtures captured off a real dashboard, with the Short routes faked per match so every
// state of the NOW group is on screen at once. Nothing touches /media, YouTube or the config:
// writes (the hooks PUT, Pick again) change this process's memory and nothing else.
//
//   node stub-server.cjs capture http://mcsr-dashboard:8080 /tmp/nowfx   # read-only GETs, once
//   STUB_FIXTURES=/tmp/nowfx PORT=8099 node stub-server.cjs              # serve
//
// capture never asks for /api/shorts/plan: on a real server that GET queues a pick (the model
// watches the match on the operator's subscription). Media: clip.mp4 (a long test clip, for the
// pick preview) and frame.png (a sync frame) in the fixtures dir, if present; thumb.png from capture.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const FX = process.env.STUB_FIXTURES || "/tmp/nowfx";
const PER_MATCH = ["meta", "publishkit", "thumbnails", "export/preview-meta", "sync", "publish", "splits"];
const GLOBAL = [
  "stages",
  "matches",
  "nightly",
  "suggestions",
  "playoffs",
  "settings",
  "youtube/status",
  "youtube/uploads",
];
const file = (p) => path.join(FX, `${p.replace(/\//g, "_")}.json`);

/* --- the states, one match each ---------------------------------------------------------------- */

const MIN = 60e3;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const slot = (days, hour) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const NOT_SIGNED_IN =
  "Antigravity is not signed in — agy exited 1 before answering (run agy once in the dashboard's container)";
const pickOf = (id, extra = {}) => ({
  gameMatchId: id,
  startMs: 381000,
  endMs: 422000,
  pov: "both",
  focus: "right",
  hookSuggestion: "3.8 SECONDS APART AT THE EYES",
  why: "the lead flips at the End entry; ends before either dragon dies",
  kind: "race",
  source: "agy",
  model: "gemini-3.8-flash-high",
  createdAt: ago(40 * MIN),
  ...extra,
});
const line = (msAgo, step, level, text, detail) => ({
  at: ago(msAgo),
  step,
  level,
  text,
  ...(detail ? { detail } : {}),
});
const pickLog = (who) => [
  line(50 * MIN, "pick", "info", "queued after the export"),
  line(49 * MIN, "pick", "info", "cutting a 2 fps proxy of the export (short-proxy.mp4)"),
  line(47 * MIN, "pick", "info", `running /watch on ${who}'s stream`),
  line(44 * MIN, "pick", "info", "asking gemini-3.8-flash-high (agy)"),
];

/** Each captured match, put in one state. The ids are the ones the capture fetched. */
const SCENARIOS = {
  // waiting, with the model's pick
  13549300: {
    preview: true,
    log: [
      ...pickLog("BeefSalad"),
      line(41 * MIN, "pick", "info", "picked 6:21–7:02, 41 s, both, BeefSalad's audio up"),
    ],
  },
  // the heuristic stands in: the model is not signed in
  13617328: {
    preview: true,
    pick: pickOf(13617328, {
      source: "heuristic",
      model: undefined,
      startMs: 376000,
      endMs: 398000,
      hookSuggestion: "DECIDED AT THE PORTAL",
      why: "the gap closes at the eye throws",
      kind: "play",
      focus: undefined,
    }),
    errors: [{ step: "pick", at: ago(43 * MIN), message: NOT_SIGNED_IN }],
    log: [
      ...pickLog("nolqndo"),
      line(
        43 * MIN,
        "pick",
        "error",
        "Antigravity is not signed in",
        "$ agy -p … --output-format json --sandbox\nexit 1\nError: not signed in. Run `agy` in a terminal to sign in with your Google account.\n    at auth (/usr/local/lib/agy/cli.js:1123:11)",
      ),
      line(43 * MIN, "pick", "warn", "the heuristic stands in: 6:16–6:38, 22 s, both"),
    ],
  },
  // the model is watching it now
  13448958: {
    state: "picking",
    detail: "the model is watching the match",
    pick: null,
    pickActivity: "running",
    activity: { step: "pick", line: "running /watch on bbiddd's stream", since: ago(2 * MIN + 10e3) },
    log: [
      line(3 * MIN, "pick", "info", "cutting a 2 fps proxy of the export (short-proxy.mp4)"),
      line(2 * MIN + 10e3, "pick", "info", "running /watch on Infume's stream"),
    ],
  },
  // hooks saved, the Short is being cut
  13446429: {
    state: "rendering",
    detail: "cutting the Short",
    titleHook: "Can the 1999 take down the 2305?",
    shortHook: "3.8 SECONDS APART AT THE EYES",
    activity: { step: "render", line: "encoding the Short", since: ago(50e3), percent: 40 },
    log: [
      line(60e3, "chain", "info", "hooks saved — rendering the Short"),
      line(55e3, "render", "info", "board and hook stills rendered"),
      line(50e3, "render", "info", "encoding the Short"),
    ],
  },
  // both on the channel, private, with times
  13473906: {
    state: "scheduled",
    titleHook: "The 7th seed vs the LCQ",
    shortHook: "A SUB-8 TO WIN IT",
    uploads: {
      video: { videoId: "aBcDeFgHiJk", publishAt: slot(1, 19) },
      short: { videoId: "kLmNoPqRsTu", publishAt: slot(2, 13) },
    },
  },
  // the long-form upload failed: quota
  13559245: {
    state: "failed",
    titleHook: "A sub-8 to win it",
    shortHook: "A SUB-8 TO WIN IT",
    errors: [
      {
        step: "upload-video",
        at: ago(12 * MIN),
        message:
          "YouTube refused the upload: quotaExceeded — the request cannot be completed because you have exceeded your quota",
      },
    ],
    log: [
      line(30 * MIN, "chain", "info", "hooks saved — rendering the Short"),
      line(28 * MIN, "render", "info", "short-13559245.mp4 rendered, 41 s"),
      line(
        13 * MIN,
        "upload-video",
        "info",
        "uploading final-13559245.mp4 (745 MiB), private, publish at 19:00 UTC",
      ),
      line(
        12 * MIN,
        "upload-video",
        "error",
        "YouTube refused the upload: quotaExceeded",
        '{\n  "error": {\n    "code": 403,\n    "message": "The request cannot be completed because you have exceeded your <a href=\\"/youtube/v3/getting-started#quota\\">quota</a>.",\n    "errors": [{ "domain": "youtube.quota", "reason": "quotaExceeded" }]\n  }\n}',
      ),
    ],
  },
  // a series: game 1's directory, the pick in game 3
  13301662: {
    pick: pickOf(13302171, {
      startMs: 370000,
      endMs: 412000,
      hookSuggestion: "GAME 3 COMES DOWN TO THE PEARLS",
    }),
    preview: { startSec: 1520, endSec: 1562 },
    detail: "Short game 3 6:10–6:52, 42 s, both",
  },
  // a series game other than game 1
  13301896: {
    state: "no-export",
    pick: null,
    detail:
      "a playoff game — the series is picked, cut and uploaded as one video from game 1 once every game is joined",
  },
  // the detector was not sure
  13223455: { preview: true, syncWeak: true, weakSync: true },
  // no Short for this one: the long-form alone
  13391780: {
    state: "scheduled",
    titleHook: "Can the 1789 take down the 2080?",
    shortHook: null,
    noShort: true,
    uploads: { video: { videoId: "zYxWvUtSrQp", publishAt: slot(1, 19) } },
  },
  13395245: {
    state: "published",
    detail: "long-form 2026-09-16 19:00 UTC, Short 2026-09-17 13:00 UTC",
    titleHook: "WANNABE vs REAL GOAT",
    shortHook: "THE PEARLS DECIDE IT",
    uploads: {
      video: { videoId: "aAX_ML4rHdo", publishAt: ago(8 * 86400e3) },
      short: { videoId: "bBX_ML4rHdo", publishAt: ago(7 * 86400e3) },
    },
  },
};

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const plans = {};
function planOf(id) {
  if (plans[id]) return plans[id];
  const s = SCENARIOS[id];
  if (!s) return null;
  const pick = s.pick === undefined ? pickOf(id) : s.pick;
  const p = {
    matchId: id,
    pick,
    shortHook: s.shortHook ?? null,
    titleHook: s.titleHook ?? null,
    ...(s.noShort ? { noShort: true } : {}),
    ...(s.syncWeak ? { syncWeak: true } : {}),
    ...(s.pickActivity ? { pickActivity: s.pickActivity } : {}),
    suggestions: {
      short: [pick?.hookSuggestion, "A SUB-8 TO WIN IT", "THE PEARLS DECIDE IT"].filter(Boolean),
      title: ["Can the 1999 take down the 2305?", "The 1999 vs the 2305", "A sub-8 to win it"],
    },
    state: s.state ?? "waiting-for-hook",
    detail:
      s.detail ??
      (s.errors?.[0]?.step !== "pick" ? s.errors?.[0]?.message : undefined) ??
      (pick
        ? `Short ${mmss(pick.startMs)}–${mmss(pick.endMs)}, ${Math.round((pick.endMs - pick.startMs) / 1000)} s, ${pick.pov}${pick.source === "heuristic" ? " · model failed, heuristic pick" : ""}`
        : undefined),
    errors: s.errors ?? [],
    ...(s.activity ? { activity: s.activity } : {}),
    log: s.log ?? [],
    ...(s.preview && pick
      ? {
          preview: {
            videoUrl: `/api/export/preview/${id}`,
            startSec: s.preview.startSec ?? 10 + pick.startMs / 1000,
            endSec: s.preview.endSec ?? 10 + pick.endMs / 1000,
          },
        }
      : {}),
    uploads: s.uploads ?? {},
  };
  if (p.state === "scheduled" && !s.detail) {
    const when = (u) => (u?.publishAt ? u.publishAt.slice(0, 16).replace("T", " ") + " UTC" : "up");
    p.detail = `long-form ${when(p.uploads.video)}${p.noShort ? ", no Short" : `, Short ${when(p.uploads.short)}`}`;
  }
  return (plans[id] = p);
}

/* --- the fixtures -------------------------------------------------------------------------------- */

const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const DEFAULT_ID = 13549300;
function perMatch(kind, id) {
  const got = read(path.join(FX, String(id), `${kind.replace(/\//g, "_")}.json`));
  if (got) {
    if (kind === "meta" && SCENARIOS[id]?.weakSync && got.sync)
      got.sync = { ...got.sync, confidence: 0.04, source: "countdown" };
    if (kind === "sync" && SCENARIOS[id]?.weakSync && got.sync) got.sync = { ...got.sync, confidence: 0.04 };
    return got;
  }
  const d = read(path.join(FX, String(DEFAULT_ID), `${kind.replace(/\//g, "_")}.json`));
  return d && { ...d, matchId: id };
}

function matchesPayload() {
  const d = read(file("matches")) ?? { matches: [] };
  for (const m of d.matches) {
    const p = planOf(m.matchId);
    if (!p) continue;
    Object.assign(m, {
      shortState: p.state,
      ...(p.detail ? { shortDetail: p.detail } : {}),
      exported: p.state !== "no-export" || m.exported,
      uploaded: !!p.uploads.video,
    });
  }
  return d;
}

function nightlyPayload() {
  const d = read(file("nightly")) ?? {};
  const ps = Object.keys(SCENARIOS).map((id) => planOf(Number(id)));
  return {
    ...d,
    // Level with the page: the "server behind" line is its own check (version-check).
    code: { boot: "b0901f1", now: "b0901f1" },
    waitingForHook: ps.filter((p) => p.state === "waiting-for-hook" && p.pick).map((p) => p.matchId),
    failed: ps.filter((p) => p.state === "failed").map((p) => p.matchId),
    picker: { ok: false, message: "Antigravity is not signed in" },
    activity: {
      running: ps.filter((p) => p.activity).map((p) => ({ matchId: p.matchId, ...p.activity })),
      queued: [13333220],
    },
  };
}

/* --- the server ------------------------------------------------------------------------------- */

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
};
function sendFile(req, res, p) {
  let size;
  try {
    size = fs.statSync(p).size;
  } catch {
    return json(res, 404, { error: `stub: no ${path.basename(p)}` });
  }
  const type = TYPES[path.extname(p)] ?? "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return fs.createReadStream(p).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  fs.createReadStream(p, { start, end }).pipe(res);
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const body = (req) =>
  new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => ok(s));
  });

async function handle(req, res) {
  const url = new URL(req.url, "http://stub");
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "api") {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (name === "Monocraft.ttf")
      return sendFile(req, res, path.join(ROOT, "remotion/assets/fonts/Monocraft.ttf"));
    if (!/^[\w.-]+$/.test(name)) return json(res, 404, { error: "not found" });
    return sendFile(req, res, path.join(ROOT, "public", name));
  }
  const [, resource, a, b] = seg;
  const id = Number(/^\d+$/.test(a ?? "") ? a : b);
  const get = req.method === "GET" || req.method === "HEAD";

  if (resource === "shorts" && a === "plan") {
    const p = planOf(Number(b));
    return p ? json(res, 200, p) : json(res, 200, { ...planOf(13395245), matchId: Number(b) });
  }
  if (resource === "shorts" && a === "hooks" && req.method === "PUT") {
    const r = JSON.parse((await body(req)) || "{}");
    const p = planOf(Number(b));
    if (!p) return json(res, 404, { error: `stub: match ${b} has no scenario` });
    if (!r.titleHook?.trim())
      return json(res, 400, {
        error: "expected { titleHook, shortHook | null, noShort? } with a title hook",
      });
    if (!r.noShort && !r.shortHook?.trim())
      return json(res, 400, { error: "a Short hook, or noShort: true for no Short" });
    if (p.uploads.video && p.titleHook !== null && r.titleHook !== p.titleHook)
      return json(res, 409, {
        error: `the long-form is already on the channel (${p.uploads.video.videoId}) — changing its hook would need a re-upload, which is the operator's call`,
      });
    Object.assign(p, {
      titleHook: r.titleHook.trim(),
      shortHook: r.noShort ? null : r.shortHook.trim(),
      noShort: !!r.noShort || undefined,
      errors: [],
      state: r.noShort ? "uploading" : "rendering",
      detail: r.noShort ? "uploading the long-form" : "cutting the Short",
      activity: r.noShort
        ? { step: "upload-video", line: "uploading final.mp4", since: new Date().toISOString(), percent: 0 }
        : {
            step: "render",
            line: "rendering the board and hook stills",
            since: new Date().toISOString(),
            percent: 0,
          },
    });
    return json(res, 202, p);
  }
  if (resource === "shorts" && a === "pick" && req.method === "POST") {
    const p = planOf(Number(b));
    if (!p) return json(res, 404, { error: `stub: match ${b} has no scenario` });
    Object.assign(p, { state: "picking", pickActivity: "queued", detail: "waiting its turn to be picked" });
    return json(res, 202, p);
  }
  if ((resource === "shorts" || resource === "export") && a === "preview" && get)
    return sendFile(req, res, path.join(FX, "clip.mp4"));
  if (resource === "sync" && a === "frame") return sendFile(req, res, path.join(FX, "frame.png"));
  if (resource === "thumbnail") return sendFile(req, res, path.join(FX, "thumb.png"));
  if ((resource === "progress" || (resource === "export" && a === "progress")) && get) {
    res.writeHead(204);
    return res.end();
  }
  if (resource === "export" && a === "project" && get) {
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end('<?xml version="1.0"?><mlt root="."/>');
  }
  // No /watch audit on record: the panel shows nothing and starts nothing.
  if (get && resource === "youtube" && a === "audit") return json(res, 200, { running: false });
  if (get && resource === "matches") return json(res, 200, matchesPayload());
  if (get && resource === "nightly" && !a) return json(res, 200, nightlyPayload());
  if (get && !a && GLOBAL.includes(resource)) return json(res, 200, read(file(resource)) ?? {});
  if (get && resource === "youtube" && GLOBAL.includes(`youtube/${a}`))
    return json(res, 200, read(file(`youtube/${a}`)) ?? {});
  const kind = resource === "export" && a === "preview-meta" ? "export/preview-meta" : resource;
  if (get && PER_MATCH.includes(kind) && id) {
    const d = perMatch(kind, id);
    return d ? json(res, 200, d) : json(res, 404, { error: `stub: no ${kind} for ${id}` });
  }
  if (resource === "meta" && req.method === "PUT")
    return json(res, 200, { ...perMatch("meta", id), ...JSON.parse((await body(req)) || "{}") });
  console.error(`stub: not faked ${req.method} ${url.pathname}`);
  return json(res, 404, { error: `stub: ${req.method} ${url.pathname} is not faked` });
}

async function capture(base, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const get = async (p, to) => {
    const r = await fetch(`${base}/api/${p}`);
    fs.writeFileSync(to, Buffer.from(await r.arrayBuffer()));
  };
  for (const p of GLOBAL) await get(p, path.join(dir, `${p.replace(/\//g, "_")}.json`));
  for (const id of Object.keys(SCENARIOS)) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    for (const p of PER_MATCH) await get(`${p}/${id}`, path.join(dir, id, `${p.replace(/\//g, "_")}.json`));
  }
  await get(`thumbnail/${DEFAULT_ID}`, path.join(dir, "thumb.png"));
  console.log(`captured into ${dir}`);
}

if (process.argv[2] === "capture") {
  capture(process.argv[3], process.argv[4] ?? FX).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  const port = Number(process.env.PORT || 8099);
  http
    .createServer((req, res) =>
      handle(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) json(res, 500, { error: String(e) });
      }),
    )
    .listen(port, "127.0.0.1", () =>
      console.log(`stub dashboard on http://127.0.0.1:${port} (fixtures ${FX})`),
    );
}
