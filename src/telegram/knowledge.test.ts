// Self-check for knowledge.ts's section picker.
// Run: npx tsx src/telegram/knowledge.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { knowledgeFor } from "./knowledge.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-"));
fs.writeFileSync(path.join(dir, "channel.md"), "# Briefing\nAlways here.\n");
fs.writeFileSync(
  path.join(dir, "money.md"),
  "# Money\nintro\n\n## Competitor earnings\nMonthly earnings guess: TOPSECRET-A\n\n## Playlists\nunrelated TOPSECRET-B\n",
);
fs.writeFileSync(path.join(dir, "other.md"), "# Other\n\n## Thumbnails\nTOPSECRET-C\n");

const out = knowledgeFor("how much are competitors earning?", 70_000, dir);
assert.ok(out.includes("Always here."), "channel.md is always in");
assert.ok(out.includes("- money.md: Money") && out.includes("- other.md: Other"), "index lists every doc");
assert.ok(out.includes("TOPSECRET-A"), "the matching section is picked");
assert.ok(!out.includes("TOPSECRET-B") && !out.includes("TOPSECRET-C"), "unrelated sections are left out");

const tight = knowledgeFor("competitors earnings", 200, dir);
assert.ok(Buffer.byteLength(tight) <= 200 && !tight.includes("TOPSECRET-A"), "the budget is respected");

assert.ok(!knowledgeFor("hello", 70_000, dir).includes("TOPSECRET"), "no match, no sections");

fs.rmSync(dir, { recursive: true });
console.log("knowledge.test.ts ok");
