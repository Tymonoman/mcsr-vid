// Renders the real Thumbnail composition and checks the two things reading the code cannot:
// that the caption prop never touches a pixel outside its own box, and that its own box never
// overlaps the three zones it must stay clear of (the seed icon, both nameplates, YouTube's
// duration stamp). Slower than the pure unit tests because it drives Chromium — same reason
// overlayRender.test.ts is excluded from `test:unit`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { bundleOnce } from "../pipeline/remotionBundle.js";
import type { ThumbnailProps } from "../../remotion/types.js";

/** 1x1 transparent PNG, so the render needs no network. */
const BLANK_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const baseProps: ThumbnailProps = {
  left: { nickname: "edcr", eloRate: 2700, avatarUrl: BLANK_AVATAR },
  right: { nickname: "Ranik_", eloRate: 2158, avatarUrl: BLANK_AVATAR },
  headerLabel: "Minecraft · Speedrunning · Ranked",
  seedType: "VILLAGE",
};

function rgba(file: string, width: number, height: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(-300)));
      const buf = Buffer.concat(chunks);
      assert.equal(buf.length, width * height * 4, `unexpected frame size for ${file}`);
      resolve(new Uint8Array(buf));
    });
  });
}

/** Rectangles from overlay.source.css, in canvas pixels (x0, y0, x1, y1). */
const SEED_ICON = { x0: 564, y0: 100, x1: 716, y1: 252 };
const PLATE_LEFT = { x0: 20, y0: 516, x1: 620, y1: 600 };
const PLATE_RIGHT = { x0: 660, y0: 516, x1: 1260, y1: 600 };
const DURATION_STAMP = { x0: 1110, y0: 625, x1: 1270, y1: 695 };
// Generous bound around `.thumb-caption` (centred at 640,466, 76px font since 8 Oct 2026's
// chip-truth fix made it larger to actually read at 168x94, 10px hard shadow): wide enough to
// hold any <=9-character caption (CAPTION_MAX_CHARS, tcCaption.ts) plus its outline, nowhere near
// the four zones above (its bottom, 510, stays clear of the nameplates' own top at 516).
const CAPTION_BOX = { x0: 60, y0: 405, x1: 1220, y1: 512 };

function overlaps(a: typeof SEED_ICON, b: typeof SEED_ICON): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

for (const zone of [SEED_ICON, PLATE_LEFT, PLATE_RIGHT, DURATION_STAMP]) {
  assert.ok(!overlaps(CAPTION_BOX, zone), `caption box overlaps a forbidden zone: ${JSON.stringify(zone)}`);
}

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-thumb-caption-test-"));
try {
  const serveUrl = await bundleOnce();
  const still = async (props: ThumbnailProps, name: string) => {
    const composition = await selectComposition({ serveUrl, id: "Thumbnail", inputProps: props });
    const out = path.join(dir, `${name}.png`);
    await renderStill({ composition, serveUrl, output: out, imageFormat: "png", inputProps: props });
    return { pixels: await rgba(out, composition.width, composition.height), width: composition.width };
  };

  const without = await still(baseProps, "without-caption");
  const width = without.width;
  assert.equal(width, 1280);

  // The absent-prop invariant the task asks for: every pixel outside the caption's own box is
  // byte-identical whether or not `caption` is set — i.e. the feature is purely additive, so a
  // match rendered without it (every match today) is unaffected. Checked for the shortest real
  // token ("58 MS") and the longest one CAPTION_MAX_CHARS (tcCaption.ts) allows ("1:36 LEAD",
  // 9 characters) — the one that most needs the box to actually be wide enough at the larger font.
  for (const caption of ["58 MS", "1:36 LEAD"]) {
    const withCaption = await still({ ...baseProps, caption }, `with-${caption.replace(/\W+/g, "-")}`);
    let changedOutsideBox = 0;
    let changedInsideBox = 0;
    for (let i = 0; i < without.pixels.length; i += 4) {
      const px = i / 4;
      const x = px % width;
      const y = Math.floor(px / width);
      const same =
        without.pixels[i] === withCaption.pixels[i] &&
        without.pixels[i + 1] === withCaption.pixels[i + 1] &&
        without.pixels[i + 2] === withCaption.pixels[i + 2] &&
        without.pixels[i + 3] === withCaption.pixels[i + 3];
      if (same) continue;
      const inBox = x >= CAPTION_BOX.x0 && x < CAPTION_BOX.x1 && y >= CAPTION_BOX.y0 && y < CAPTION_BOX.y1;
      if (inBox) changedInsideBox++;
      else changedOutsideBox++;
    }
    assert.equal(changedOutsideBox, 0, `"${caption}" changed a pixel outside its own box`);
    assert.ok(changedInsideBox > 0, `"${caption}" changed no pixel at all — it did not render`);
  }

  console.log("thumbnailCaption: caption is additive-only, and its box clears every forbidden zone");
} finally {
  await rm(dir, { recursive: true, force: true });
}
