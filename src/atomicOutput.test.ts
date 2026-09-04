import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicOutput } from "./atomicOutput.js";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-atomic-"));

try {
  // A completed render lands under the real name, leaving no .part behind.
  const good = path.join(dir, "overlay.mov");
  const returned = await atomicOutput(good, async (tmp) => {
    assert.equal(path.basename(tmp), "overlay.part.mov", "temp name must keep the extension");
    // ffmpeg picks its muxer from the extension; `overlay.mov.part` would not produce ProRes.
    assert.equal(path.extname(tmp), ".mov");
    assert.ok(!existsSync(good), "final name must not exist while the render is in flight");
    await writeFile(tmp, "finished");
    return "result";
  });
  assert.equal(returned, "result", "the render's return value passes through");
  assert.ok(existsSync(good), "final artifact exists after success");
  assert.deepEqual(await readdir(dir), ["overlay.mov"], "no .part left behind");

  // The case this exists for: a render killed partway (OOM, restart, Ctrl-C) must NOT leave
  // anything that pipeline.ts:205 and matchStatus.ts:69 would read as a finished artifact.
  const bad = path.join(dir, "killed.mov");
  await assert.rejects(
    atomicOutput(bad, async (tmp) => {
      await writeFile(tmp, "half a gigabyte of truncated prores");
      throw new Error("OOM");
    }),
    /OOM/,
  );
  assert.ok(!existsSync(bad), "a failed render must never produce the final name");
  assert.ok(existsSync(path.join(dir, "killed.part.mov")), "the partial stays under .part");

  // A leftover .part from a previous crash must not be appended to by the retry.
  await atomicOutput(bad, async (tmp) => {
    const stale = await readdir(dir);
    assert.equal(stale.includes("killed.part.mov"), false, "stale .part cleared before retry");
    await writeFile(tmp, "clean");
  });
  assert.ok(existsSync(bad), "retry after a crash succeeds");

  console.log("atomicOutput: all checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
