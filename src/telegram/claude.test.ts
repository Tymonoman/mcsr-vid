// Self-check for claude.ts: the adapter classifies the CLI's own envelope correctly and never
// retries, from tiny fake binaries written to a temp dir — no real token spent here (the one real
// run against the installed `claude` binary is logged separately, not in this test).
// Run: npx tsx src/telegram/claude.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTH_RE, describeFailure, LIMIT_RE, runClaude, type ClaudeFailure } from "./claude.js";

const dir = mkdtempSync(path.join(tmpdir(), "claude-fake-"));
/** A tiny node script, chmod'd executable, that prints `body`'s output then exits. */
function script(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
/** `process.stdout.write(<the JSON text of o>)`, baked into the fake script as a string literal
 *  — no re-serializing at the fake's runtime, so what it prints is exactly `o`. */
const writesEnvelope = (o: Record<string, unknown>) => `process.stdout.write(${JSON.stringify(JSON.stringify(o))});`;

try {
  // ok: the CLI's own envelope, trimmed.
  const ok = script("ok.js", writesEnvelope({ type: "result", is_error: false, result: "  OK plain text  " }));
  assert.deepEqual(await runClaude("hi", { binary: ok, systemPrompt: "s" }), { ok: true, text: "OK plain text" });

  // empty: a success envelope with nothing in it — not read as the bare envelope JSON itself.
  const empty = script("empty.js", writesEnvelope({ type: "result", is_error: false, result: "" }));
  assert.deepEqual(await runClaude("hi", { binary: empty, systemPrompt: "s" }), {
    ok: false,
    kind: "empty",
    message: "answered nothing",
  });

  // non-JSON stdout: taken as the answer itself, same as a bare-prose CLI.
  const nonjson = script("nonjson.js", `process.stdout.write("just some plain text");`);
  assert.deepEqual(await runClaude("hi", { binary: nonjson, systemPrompt: "s" }), {
    ok: true,
    text: "just some plain text",
  });

  // limit: wording the CLI has actually shown, classified without anyone teaching it this one.
  const limitText = "You've hit your usage limit · resets 3pm";
  const limit = script(
    "limit.js",
    `${writesEnvelope({ type: "result", is_error: true, result: limitText })}\nprocess.exitCode = 1;`,
  );
  const limited = await runClaude("hi", { binary: limit, systemPrompt: "s" });
  assert.equal(limited.ok, false);
  assert.equal((limited as ClaudeFailure).kind, "limit");
  assert.equal(describeFailure(limited as ClaudeFailure), "usage limit reached — try again later");

  // auth: not signed in — the CLI's own "/login" wording.
  const auth = script(
    "auth.js",
    `${writesEnvelope({ type: "result", is_error: true, result: "Please run /login to continue" })}\nprocess.exitCode = 1;`,
  );
  const unauthed = await runClaude("hi", { binary: auth, systemPrompt: "s" });
  assert.equal(unauthed.ok, false);
  assert.equal((unauthed as ClaudeFailure).kind, "auth");
  assert.equal(
    describeFailure(unauthed as ClaudeFailure),
    "run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in /app/.env",
  );

  // missing: no binary at that path at all — ENOENT, not a hang.
  const missing = await runClaude("hi", { binary: path.join(dir, "does-not-exist"), systemPrompt: "s" });
  assert.equal(missing.ok, false);
  assert.equal((missing as ClaudeFailure).kind, "missing");
  assert.equal(describeFailure(missing as ClaudeFailure), "binary missing in the container");

  // timeout: a child that outlives the deadline is SIGTERM'd, not waited out to its grace period.
  const sleep = script("sleep.js", `setInterval(() => {}, 1000);`);
  const startedAt = Date.now();
  const timedOut = await runClaude("hi", { binary: sleep, systemPrompt: "s", timeoutMs: 150 });
  assert.ok(Date.now() - startedAt < 3000, "did not wait out the SIGKILL grace period");
  assert.equal(timedOut.ok, false);
  assert.equal((timedOut as ClaudeFailure).kind, "timeout");

  // The env the child gets is a short allow-list — never this process's own secrets.
  process.env.A_SECRET_NOBODY_SHOULD_FORWARD = "shh";
  try {
    const echo = script(
      "echo.js",
      `process.stdout.write(JSON.stringify({is_error:false,result:JSON.stringify(process.env)}));`,
    );
    const reply = await runClaude("hi", { binary: echo, systemPrompt: "s" });
    assert.ok(reply.ok, JSON.stringify(reply));
    const childEnv = JSON.parse((reply as { ok: true; text: string }).text) as Record<string, string>;
    assert.equal(childEnv.A_SECRET_NOBODY_SHOULD_FORWARD, undefined);
    assert.equal(childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.ok(childEnv.PATH);
  } finally {
    delete process.env.A_SECRET_NOBODY_SHOULD_FORWARD;
  }

  // The regexes against wording seen for real, not just the fakes above.
  assert.ok(LIMIT_RE.test("Claude AI usage limit reached|1760000000"));
  assert.ok(LIMIT_RE.test(limitText));
  assert.ok(AUTH_RE.test("Please run /login to continue"));
  assert.ok(!LIMIT_RE.test("the render finished"));
  assert.ok(!AUTH_RE.test("the render finished"));

  console.log("claude: all checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
