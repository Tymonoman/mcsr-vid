import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { auditPath, auditState, buildAuditPrompt, startAudit, type AuditInput } from "./audit.js";
import { config } from "./config.js";

const base: AuditInput = {
  matchId: 998001,
  videoId: "abc123XYZ",
  title: "Decided by 2.4 seconds | edcr vs doogile | MCSR Ranked 1v1",
  description: "",
  players: ["edcr", "doogile"],
  stats: { views: 1200, likes: 88, comments: 14 },
  reach: { impressions: 5703, ctr: 0.0109 },
};

// --- The prompt. An unconstrained "review this" comes back summarising the match, which is the
// one thing the operator already knows, so the brief has to be specific.

const prompt = buildAuditPrompt(base);
assert.match(prompt, /^Run \/watch https:\/\/www\.youtube\.com\/watch\?v=abc123XYZ/);
assert.match(prompt, /edcr/);
assert.match(prompt, /doogile/);
// The numbers matter: a reviewer that knows CTR was 1.09% can tie a weak hook to a weak click.
assert.match(prompt, /views 1200, likes 88, comments 14/);
assert.match(prompt, /click-through 1\.09%/);
// Every section the report is supposed to have.
for (const section of ["Mistakes", "First 10 seconds", "Pacing", "Thumbnail and title", "Next upload"]) {
  assert.ok(prompt.includes(section), `prompt is missing the "${section}" section`);
}
// Guards against the two failure modes of an LLM review: inventing defects, and being nice.
assert.match(prompt, /If you find none, say so plainly rather than inventing something/);
assert.match(prompt, /Vague praise is worse than nothing/);

// A video with no data yet says so, rather than printing "click-through NaN%".
const noData = buildAuditPrompt({ ...base, stats: null, reach: null });
assert.match(noData, /No performance data yet\./);
assert.ok(!noData.includes("NaN"));
// ...and it must not then point the reviewer at "the click-through rate above", which is an
// invitation to invent one.
assert.ok(!noData.includes("click-through rate above"));
assert.match(noData, /First 10 seconds\*\* — does the opening earn the click\?/);
assert.match(prompt, /click-through rate above/);

// --- Running it. The command is arbitrary, so every way it can misbehave has to be survivable:
// this exact pattern already took the dashboard down once via an unhandled EPIPE.

const dir = path.join(config.mediaDir, String(base.matchId));
await mkdir(dir, { recursive: true });

const settled = (matchId: number): Promise<void> =>
  new Promise((resolve) => {
    const tick = () => (auditState(matchId).running ? setTimeout(tick, 25) : resolve());
    tick();
  });

// Happy path: stdout is captured and written to the report file.
process.env.AUDIT_CMD = "printf '## Mistakes\\nNone found.\\n'";
startAudit(base);
await settled(base.matchId);
assert.equal(auditState(base.matchId).error, null);
assert.match(await readFile(auditPath(base.matchId), "utf8"), /None found\./);

// A command that exits non-zero without reading stdin: the write to its stdin races its exit,
// and an unhandled EPIPE here would kill the whole server rather than fail one audit.
process.env.AUDIT_CMD = "false";
startAudit({ ...base, matchId: 998002 });
await settled(998002);
assert.match(auditState(998002).error ?? "", /exited with code 1/);

// A missing binary names the command, so the fix ("claude is not on PATH in the container") is
// obvious rather than a bare ENOENT.
process.env.AUDIT_CMD = "definitely-not-a-real-binary-xyz";
startAudit({ ...base, matchId: 998003 });
await settled(998003);
assert.match(auditState(998003).error ?? "", /exited with code 127/);

// stderr is kept: a missing /watch plugin or an unauthenticated CLI complains there, and that
// is exactly the message worth surfacing.
process.env.AUDIT_CMD = "printf 'plugin not installed\\n' >&2; exit 3";
startAudit({ ...base, matchId: 998004 });
await settled(998004);
assert.match(auditState(998004).output, /plugin not installed/);

// A timeout is reported as a timeout, not as a mysterious signal.
process.env.AUDIT_TIMEOUT_MS = "150";
process.env.AUDIT_CMD = "sleep 5";
startAudit({ ...base, matchId: 998005 });
await settled(998005);
assert.match(auditState(998005).error ?? "", /timed out/);
delete process.env.AUDIT_TIMEOUT_MS;
delete process.env.AUDIT_CMD;

// A match that was never audited reports idle rather than throwing.
const fresh = auditState(998999);
assert.equal(fresh.running, false);
assert.equal(fresh.reportPath, null);

await rm(dir, { recursive: true, force: true });
console.log("audit: all checks passed");
