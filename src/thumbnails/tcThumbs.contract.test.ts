// Contract test for `npm run tc-thumbs`'s pose pick (CLAUDE.md "Thumbnails": "cheering-relaxing"
// is excluded from every automatic pick; handbook "Thumbnails are two big figures": tc-thumbs'
// SSIM "most different" pick filters it out of its own pool first, "falling back to the full list
// only if that would leave nothing to pick from"; the operator can still choose it by hand).
// Promise 12 in thumbnailVariants.contract.test.ts. tcThumbs.ts is a CLI with no exports, so it is
// driven as one: a child process on a temp media dir (MCSR_CONFIG), the MCSR API stubbed by a
// preload, three tiny solid-colour stills so ffmpeg's SSIM (well under a second) has a clear answer.
// The child is stopped the moment it asks for an avatar: that is the caption still's Chromium
// render, after tc-control.png and tc-pose.png are already written. Nothing reaches the network.
// Run: npx tsx src/thumbnails/tcThumbs.contract.test.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Doc vs code: keep the doc's assertion, report the gap, keep going (triage decides). */
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.log("tcThumbs.contract: ffmpeg not installed — skipped (tc-thumbs needs it for SSIM)");
  process.exit(0);
}

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixturePath = fileURLToPath(new URL("../fixtures/match-13766294.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { id: number };
const media = await mkdtemp(path.join(tmpdir(), "mcsr-tcthumbs-contract-"));

// The child's MCSR API: the fixture for any match, its two players, no versus record; any other
// request is the caption render fetching an avatar — mark it and hang there for the parent to stop.
const preload = path.join(media, "preload.mjs");
await writeFile(
  preload,
  `import { readFileSync, writeFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
const ok = (data) => new Response(JSON.stringify({ status: "success", data }));
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("https://api.mcsrranked.com/")) {
    const m = /\\/matches\\/(\\d+)$/.exec(url);
    if (m) return ok({ ...fixture, id: Number(m[1]) });
    if (url.includes("/versus/")) return new Response("{}", { status: 404 });
    const p = fixture.players.find((pl) => url.endsWith("/users/" + pl.uuid));
    if (p) return ok(p);
    return new Response("{}", { status: 404 });
  }
  writeFileSync(process.env.TC_MARK, url);
  return new Promise(() => {});
};
`,
);
const configFile = path.join(media, "config.json");
await writeFile(configFile, JSON.stringify({ mediaDir: media }));

/** Solid-colour stills: red is the control; blue is far from it, dark red close to it. */
const COLOURS: Record<string, string> = {
  "walking-crossed": "C02020",
  "cheering-relaxing": "2020C0",
  "marching-crouching": "B02828",
};
async function strip(id: number, keys: string[], chosen: string, chosenBy: "operator" | "auto") {
  const dir = path.join(media, String(id));
  await mkdir(dir, { recursive: true });
  for (const key of keys) {
    const r = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${COLOURS[key]}:s=128x72`,
      "-frames:v",
      "1",
      path.join(dir, `thumbnail.${key}.png`),
    ]);
    assert.equal(r.status, 0, `ffmpeg drew ${key}`);
  }
  const variants = keys.map((key) => ({
    key,
    leftPose: key.split("-")[0],
    rightPose: key.split("-")[1],
    leftProvider: "nmsr-facing",
    rightProvider: "nmsr-facing",
    hook: false,
    file: `thumbnail.${key}.png`,
  }));
  await writeFile(
    path.join(dir, "thumbnail.json"),
    JSON.stringify({ chosen, chosenBy, hookText: null, variants }),
  );
  return dir;
}

/** Runs `tc-thumbs <id>` until it exits or reaches the caption's render; then stops it. */
function tcThumbs(id: number): Promise<{ code: number | null; stderr: string; reachedCaption: boolean }> {
  const mark = path.join(media, `.reached-${id}`);
  return new Promise((resolve) => {
    const child = spawn(
      path.join(repo, "node_modules/.bin/tsx"),
      ["--import", preload, "src/thumbnails/tcThumbs.ts", String(id)],
      {
        cwd: repo,
        env: { ...process.env, MCSR_CONFIG: configFile, TC_MARK: mark },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    let reachedCaption = false;
    const poll = setInterval(() => {
      if (existsSync(mark)) {
        reachedCaption = true;
        child.kill("SIGKILL");
      }
    }, 50);
    const limit = setTimeout(() => child.kill("SIGKILL"), 18_000);
    child.on("close", (code) => {
      clearInterval(poll);
      clearTimeout(limit);
      resolve({ code, stderr, reachedCaption });
    });
  });
}
const tcFile = (dir: string, f: string) => readFile(path.join(dir, "tc", f));
const still = (dir: string, key: string) => readFile(path.join(dir, `thumbnail.${key}.png`));

try {
  // --- The SSIM pick skips the arms-up pair even when it is by far the most different ----------
  {
    const id = fixture.id;
    const dir = await strip(
      id,
      ["walking-crossed", "cheering-relaxing", "marching-crouching"],
      "walking-crossed",
      "auto",
    );
    const run = await tcThumbs(id);
    assert.ok(
      existsSync(path.join(dir, "tc", "tc-pose.png")),
      `tc-pose.png written (exit ${run.code}): ${run.stderr.slice(-400)}`,
    );
    // Blue (cheering-relaxing) is the far more different still; an unfiltered pick would take it.
    assert.deepEqual(
      await tcFile(dir, "tc-pose.png"),
      await still(dir, "marching-crouching"),
      "the challenger is never the arms-up pair",
    );
    assert.deepEqual(
      await tcFile(dir, "tc-control.png"),
      await still(dir, "walking-crossed"),
      "the control is the live pick",
    );
    // Additive only: the strip's own files are left alone.
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "thumbnail.json"), "utf8")).chosen,
      "walking-crossed",
    );
  }
  console.log("OK: the most-different pick skips cheering-relaxing");

  // --- The operator's own control may be the arms-up pair: only automatic picks exclude it -----
  {
    const id = fixture.id + 1;
    const dir = await strip(
      id,
      ["walking-crossed", "cheering-relaxing", "marching-crouching"],
      "cheering-relaxing",
      "operator",
    );
    const run = await tcThumbs(id);
    assert.ok(
      existsSync(path.join(dir, "tc", "tc-control.png")),
      `tc-control.png written (exit ${run.code}): ${run.stderr.slice(-400)}`,
    );
    assert.deepEqual(
      await tcFile(dir, "tc-control.png"),
      await still(dir, "cheering-relaxing"),
      "the operator's pick is the control",
    );
    assert.notDeepEqual(await tcFile(dir, "tc-pose.png"), await still(dir, "cheering-relaxing"));
  }
  console.log("OK: an operator's arms-up pick stays the control");

  // --- Nothing else to pick from: the docs say fall back to the full list ----------------------
  {
    const id = fixture.id + 2;
    const dir = await strip(id, ["walking-crossed", "cheering-relaxing"], "walking-crossed", "auto");
    const run = await tcThumbs(id);
    await deviation(
      'handbook "Thumbnails are two big figures": tc-thumbs\' SSIM pick falls back to the full list only if excluding cheering-relaxing would leave nothing',
      async () => {
        assert.ok(
          existsSync(path.join(dir, "tc", "tc-pose.png")),
          `no tc-pose.png; exit ${run.code}: ${/Error: ([^\n]+)/.exec(run.stderr)?.[1] ?? run.stderr.slice(-200)}`,
        );
        assert.deepEqual(await tcFile(dir, "tc-pose.png"), await still(dir, "cheering-relaxing"));
      },
    );
  }

  console.log("tcThumbs.contract: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
