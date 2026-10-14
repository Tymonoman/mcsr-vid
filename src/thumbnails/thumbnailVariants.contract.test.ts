// Contract test for the thumbnail variant strip, written from the docs (CLAUDE.md "Thumbnails",
// handbook/claude-md-reference.md "Thumbnails are two big figures and two names") before reading
// the code, by someone who did not write it. Covers what thumbnailVariants.test.ts does not.
//
// The promises the docs make for this feature (this file pins 1-6; rerender/thumbnailSwap/busy/
// tcThumbs .contract.test.ts pin the rest):
//   1. Four pose pairs render; the first (walking/crossed) is the auto default.
//   2. `thumbnailRotatePoses` is off by default; off, every fresh auto pick is that first pair.
//   3. On, a fresh auto pick rotates deterministically by match id among the pairs actually
//      rendered (same id, same pick on every re-render, so nothing flaps before a choice is saved).
//   4. An operator's pick is never touched by a re-render, rotation on or off.
//   5. "cheering-relaxing" (reads as the result) is excluded from EVERY automatic pick — rotation
//      and the SSIM pick alike — falling back to the full list only when nothing else is left.
//   6. The operator can still choose it by hand; a pick by hand is recorded as the operator's,
//      and only that ticks the checklist's thumbnail pill (an automatic default says "auto").
//   7. Re-render: every variant drawn again into `thumbnail-new/`, never over the live set.
//   8. Live files (`thumbnail.png`, the manifest, the variant PNGs) change only on an operator
//      press: "Use this" (not on the channel) or "Put on YouTube" / "Undo on YouTube" (on it).
//   9. Undo goes back to what the video wore before the dashboard first touched it.
//  10. Blocked players apply to re-render, Use this and Put exactly as everywhere else: POV clips,
//      saved chats AND the title's "A vs B" pair (so an archived match is still caught),
//      whole-string, case-insensitive.
//  11. A re-render or a pending put counts as busy for the match's other writers (busyIn),
//      restart-when-idle and the nightly, same as a render or an export.
//  12. tc-thumbs' "most different" pose never auto-picks cheering-relaxing.
// Untestable here without Chromium: "name-only plates, seed type above the VS, no rating/seed/
// placement text" is a property of the drawn PNG (computeThumbnailProps still carries eloRate).
// Run: npx tsx src/thumbnails/thumbnailVariants.contract.test.ts
import assert from "node:assert/strict";
import { deviation } from "../fixtures/deviation.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import {
  autoDefaultKey,
  chooseVariant,
  manifestPath,
  RESULT_LOOKING_POSE_KEY,
  renderThumbnailVariants,
  variantFile,
  variantKey,
  type VariantsManifest,
} from "./thumbnailVariants.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

// A real ranked match (type 2, so no bracket lookup). Every render below finds its stills on disk:
// what is under test is which still the strip decides on, not Chromium drawing one.
const match = JSON.parse(
  await readFile(new URL("../fixtures/match-13766294.json", import.meta.url), "utf8"),
) as MatchInfo;
const [pl, pr] = match.players;
const user = (p: typeof pl): UserDetails =>
  ({ uuid: p!.uuid, nickname: p!.nickname, eloRate: p!.eloRate, eloRank: p!.eloRank }) as UserDetails;

// Nothing on these paths may reach the network: avatar URLs are computed, never fetched, when the
// still is reused. A fetch here would be the render quietly depending on NMSR or the API.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("no network in this test");
}) as typeof fetch;

const dirs: string[] = [];
async function strip(poses = config.thumbnailVariants): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-variants-contract-"));
  dirs.push(dir);
  for (const p of poses) await writeFile(path.join(dir, variantFile(p)), `still ${variantKey(p)}`);
  return dir;
}
const render = (dir: string, poses = config.thumbnailVariants, id = match.id) =>
  renderThumbnailVariants({
    match: { ...match, id },
    userLeft: user(pl),
    userRight: user(pr),
    outDir: dir,
    poses,
  });
const live = (dir: string) => readFile(path.join(dir, "thumbnail.png"), "utf8");
const KEYS = DEFAULTS.thumbnailVariants.map(variantKey);
const SAFE = KEYS.filter((k) => k !== RESULT_LOOKING_POSE_KEY);

try {
  // --- 1. Four pose pairs, walking/crossed first -------------------------------------------------
  // "Four pose pairs" and "the first (walking/crossed) the auto default": every published match so
  // far wears that first pair, so its position in the list is load-bearing, not cosmetic.
  assert.equal(DEFAULTS.thumbnailVariants.length, 4, "four pose pairs by default");
  assert.equal(KEYS[0], "walking-crossed", "walking/crossed is the first pair");
  // The result-looking pair is one of the four that render — which is why the exclusion exists.
  assert.ok(KEYS.includes(RESULT_LOOKING_POSE_KEY), "cheering-relaxing is rendered");
  assert.equal(RESULT_LOOKING_POSE_KEY, "cheering-relaxing", "the excluded key is the arms-up pair");
  console.log("OK 1: four pose pairs, walking-crossed first");

  // --- 2. Rotation off (default): every fresh auto pick is the first pair --------------------------
  assert.equal(DEFAULTS.thumbnailRotatePoses, false, "thumbnailRotatePoses defaults to off");
  assert.equal(config.thumbnailRotatePoses, false, "and the test runs on DEFAULTS");
  {
    // End to end with the real match: no manifest yet, so this is a fresh auto pick.
    const dir = await strip();
    const m = await render(dir);
    assert.equal(m.chosen, "walking-crossed", "off: the first pair, whatever the match id");
    // Who picked it: the renderer. The publish checklist ticks the thumbnail on "operator" only,
    // so a render must never claim a human looked at the strip.
    assert.equal(m.chosenBy, "auto");
    assert.equal(await live(dir), "still walking-crossed", "thumbnail.png is the chosen still");
    assert.deepEqual(
      m.variants.map((v) => v.key),
      KEYS,
      "every pair rendered is listed, in config order",
    );
    // Off ignores the id: a sweep of ids all land on the first pair.
    for (const id of [0, 1, 2, 3, 13766294, 99999999]) {
      assert.equal(autoDefaultKey(id, KEYS), "walking-crossed", `off, id ${id}`);
    }
  }
  console.log("OK 2: rotation off picks the first pair for every id");

  // --- 5 (off). The exclusion is not just a rotation detail: with rotation OFF and the arms-up
  // pair listed first (a reordered config), the auto default still skips it ------------------------
  {
    const reordered = [
      DEFAULTS.thumbnailVariants[2]!,
      ...DEFAULTS.thumbnailVariants.filter((_, i) => i !== 2),
    ];
    assert.equal(variantKey(reordered[0]!), RESULT_LOOKING_POSE_KEY);
    assert.equal(
      autoDefaultKey(match.id, reordered.map(variantKey)),
      "walking-crossed",
      "off, cheering-relaxing first: the next pair, never it",
    );
    const dir = await strip(reordered);
    const m = await render(dir, reordered);
    assert.notEqual(m.chosen, RESULT_LOOKING_POSE_KEY, "the real render skips it too");
    assert.notEqual(await live(dir), `still ${RESULT_LOOKING_POSE_KEY}`, "and so does thumbnail.png");
    // Falls back to the full list only when nothing else is left (a one-pair config).
    assert.equal(autoDefaultKey(match.id, [RESULT_LOOKING_POSE_KEY]), RESULT_LOOKING_POSE_KEY);
  }
  console.log("OK 5: cheering-relaxing is skipped by the auto default even with rotation off");

  // --- 3 + 5 (on). Rotation: deterministic by id, among the pairs actually rendered ---------------
  config.thumbnailRotatePoses = true;
  try {
    const seen = new Set<string>();
    for (let id = 0; id < 300; id++) {
      const pick = autoDefaultKey(id, KEYS);
      // The arms-up pair reads as the result: no id may ever land on it automatically.
      assert.notEqual(pick, RESULT_LOOKING_POSE_KEY, `id ${id} auto-picked the result-looking pose`);
      // Same id, same pick: a render retried before a choice is saved must not flap.
      assert.equal(autoDefaultKey(id, KEYS), pick, `id ${id} is deterministic`);
      seen.add(pick);
    }
    // "Rotation" that only ever lands on one pair would leave the 88%-one-pose problem in place
    // (7 Oct 2026 packaging audit): every safe pair must be reachable.
    assert.deepEqual([...seen].sort(), [...SAFE].sort(), "on: every safe pair is reachable");

    // "Among the pairs actually rendered": a pair that is not in the strip is never picked, even
    // when the config lists more (a pose that failed to render, a shorter strip on an old match).
    const rendered = ["marching-crouching", "default-default"];
    for (let id = 0; id < 50; id++) {
      assert.ok(rendered.includes(autoDefaultKey(id, rendered)), `id ${id} picked a pair not rendered`);
    }

    // End to end: 13766294 ≡ 2 (mod 4) — the slot cheering-relaxing holds in the full list, so an
    // unfiltered rotation would land on it. The real renderer must not.
    assert.equal(match.id % KEYS.length, KEYS.indexOf(RESULT_LOOKING_POSE_KEY));
    const dir = await strip();
    const first = await render(dir);
    assert.notEqual(first.chosen, RESULT_LOOKING_POSE_KEY, "the real render never lands on it");
    assert.ok(SAFE.includes(first.chosen), "it lands on a rendered safe pair");
    assert.equal(first.chosenBy, "auto");
    assert.equal(await live(dir), `still ${first.chosen}`);
    // Re-run before anyone chose: same pick (the carried auto choice, and the same id anyway).
    const again = await render(dir);
    assert.equal(again.chosen, first.chosen, "a retried render does not flap between poses");

    // Rotation varies across matches end to end, not only in the pure helper: some id in a small
    // range lands somewhere other than the first pair.
    const picks = new Set<string>();
    for (const id of [13766292, 13766293, 13766294, 13766295]) {
      const d = await strip();
      picks.add((await render(d, config.thumbnailVariants, id)).chosen);
    }
    assert.ok(picks.size > 1, `rotation on picked only ${[...picks]} across four consecutive ids`);
    assert.ok(!picks.has(RESULT_LOOKING_POSE_KEY));
  } finally {
    config.thumbnailRotatePoses = false;
  }
  console.log("OK 3: rotation on is deterministic, reaches every safe pair, never the arms-up one");

  // --- 4 + 6. An operator's pick survives every re-render, rotation on or off ---------------------
  {
    const dir = await strip();
    await render(dir);
    // A pick by hand — even of the result-looking pair, which only the automatic paths refuse.
    const picked = await chooseVariant(dir, RESULT_LOOKING_POSE_KEY);
    assert.equal(picked.chosenBy, "operator", "a pick by hand is the operator's");
    assert.equal(await live(dir), `still ${RESULT_LOOKING_POSE_KEY}`, "and it is what goes up");
    for (const rotate of [false, true]) {
      config.thumbnailRotatePoses = rotate;
      try {
        const m = await render(dir);
        assert.equal(m.chosen, RESULT_LOOKING_POSE_KEY, `rotation ${rotate}: the operator's pick stands`);
        assert.equal(m.chosenBy, "operator", `rotation ${rotate}: still the operator's`);
        assert.equal(await live(dir), `still ${RESULT_LOOKING_POSE_KEY}`);
      } finally {
        config.thumbnailRotatePoses = false;
      }
    }
    // A different hand pick, then a re-render with the config grown by nothing: still that one.
    await chooseVariant(dir, "default-default");
    config.thumbnailRotatePoses = true;
    try {
      assert.equal((await render(dir)).chosen, "default-default", "a second hand pick stands too");
    } finally {
      config.thumbnailRotatePoses = false;
    }
  }
  console.log("OK 4/6: an operator's pick (even arms-up) is never rotated or re-picked away");

  // --- 5 (carried). A re-render that keeps an earlier AUTOMATIC choice of the arms-up pair ------
  // Hypothetical, narrow: a manifest carries `chosen: "cheering-relaxing", chosenBy: "auto"` only
  // if rotation was switched on between d367eff (rotation, 7 Oct 2026 00:13 UTC) and 4dc9b1a (the
  // exclusion, 7 Oct 23:58 UTC). Keeping an earlier choice is on purpose (thumbnailVariants.ts:
  // "so re-running the pipeline does not silently swap the thumbnail"); the docs still say no
  // automatic path lands on that pose, so the gap is reported for triage to weigh.
  {
    const dir = await strip();
    const before: VariantsManifest = {
      chosen: RESULT_LOOKING_POSE_KEY,
      chosenBy: "auto",
      hookText: null,
      variants: DEFAULTS.thumbnailVariants.map((p) => ({
        key: variantKey(p),
        leftPose: p.left,
        rightPose: p.right,
        leftProvider: "nmsr-facing",
        rightProvider: "nmsr-facing",
        hook: false,
        file: variantFile(p),
      })),
    };
    await writeFile(manifestPath(dir), JSON.stringify(before));
    const m = await render(dir);
    await deviation(
      'CLAUDE.md "Thumbnails": "cheering-relaxing" is excluded from every automatic pick (a carried chosenBy:"auto" choice; hypothetical, needs rotation on during 7 Oct 00:13–23:58 UTC)',
      async () => {
        assert.ok(
          !(m.chosen === RESULT_LOOKING_POSE_KEY && m.chosenBy === "auto"),
          `a re-render rewrote chosen "${m.chosen}" chosenBy "${m.chosenBy}" and thumbnail.png = "${await live(dir)}"`,
        );
      },
    );
  }

  assert.equal(fetches, 0, "nothing here reached the network");
  console.log("thumbnailVariants.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.thumbnailRotatePoses = false;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
