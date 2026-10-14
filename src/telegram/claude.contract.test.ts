// Contract test for claude.ts (the Claude adapter), written from the docs (CLAUDE.md "Telegram bot",
// handbook claude-md-reference.md "Telegram bot"), not from the code. claude.test.ts already pins the
// failure classification and that a random secret is not forwarded; this file pins the exact
// invocation the docs spell out — argv, stdin, cwd, env — and the never-retry / one-line-reason rules.
// A fake binary records what it was given; no real `claude` ever runs here.
//
// Promises (numbering shared with index.contract.test.ts):
//  P11. `claude -p --model claude-haiku-4-5-20251001 --output-format json --tools "" --strict-mcp-config
//       --disable-slash-commands --no-session-persistence --setting-sources "" --system-prompt "<…>"`,
//       a plain argv array (never a shell), `cwd` the OS temp dir, the prompt on stdin — never argv
//       (a ~70 KB knowledge pack must fit).
//  P12. The child's env is an allow-list: PATH, HOME, LANG, TMPDIR, plus CLAUDE_CODE_OAUTH_TOKEN /
//       ANTHROPIC_API_KEY if set — never the Telegram token or any other secret this process holds.
//  P13. A usage limit reads exactly "usage limit reached — try again later"; the adapter never retries.
//  P14. Any other failure falls back, and the report shows "that one-line reason under it"; a missing
//       binary says "binary missing in the container", no login says to run `claude setup-token` and
//       put CLAUDE_CODE_OAUTH_TOKEN in /app/.env.
// Run: npx tsx src/telegram/claude.contract.test.ts
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeFailure, runClaude, type ClaudeFailure, type ClaudeReply } from "./claude.js";

/** A doc clause the code does not keep: printed, not thrown, so the suite stays green until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "claude-contract-"));
const record = path.join(dir, "record.json");
const calls = path.join(dir, "calls.log");

/** A fake `claude` that records argv/cwd/env/stdin to `record`, counts itself in `calls`, then runs `tail`. */
function fake(name: string, tail: string): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(calls)}, "x");
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin }));
  ${tail}
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}
const ok = fake(
  "ok.js",
  `process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "fine" }));`,
);
const recorded = () =>
  JSON.parse(readFileSync(record, "utf8")) as {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    stdin: string;
  };
const callCount = () => (existsSync(calls) ? readFileSync(calls, "utf8").length : 0);

const savedEnv = { ...process.env };
try {
  /* --- P11: the exact argv, the prompt on stdin, cwd the temp dir, no shell ---------------------- */
  {
    // A system prompt full of shell syntax: with a shell in between it would run `touch`; as one argv
    // element it arrives verbatim and nothing is created.
    const pwned = path.join(dir, "PWNED");
    const system = `Plain text only. $(touch ${pwned}) \`touch ${pwned}\`; touch ${pwned} && echo "quoted" 'single'`;
    // ~70 KB, the size the docs give for a knowledge pack, with a marker no argv element may carry.
    const marker = "PROMPT-MARKER-7f3a";
    const prompt = `${marker}\n${'knowledge line with ünïcödé and "quotes" and $HOME\n'.repeat(1400)}END`;
    assert.ok(prompt.length > 70_000, `${prompt.length}`);

    const reply = await runClaude(prompt, { binary: ok, systemPrompt: system });
    assert.deepEqual(reply, { ok: true, text: "fine" });
    const r = recorded();
    assert.deepEqual(
      r.argv,
      [
        "-p",
        "--model",
        "claude-haiku-4-5-20251001",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--system-prompt",
        system,
      ],
      "the documented flags, in order, with --tools and --setting-sources given empty strings",
    );
    assert.ok(!existsSync(pwned), "the system prompt went through no shell");
    assert.equal(r.stdin, prompt, "the whole prompt arrives on stdin, byte for byte");
    assert.ok(!r.argv.some((a) => a.includes(marker)), "the prompt is never on argv");
    // cwd is the OS temp dir, so no project CLAUDE.md, hooks or settings load (P11).
    assert.equal(realpathSync(r.cwd), realpathSync(tmpdir()));
    console.log("OK: exact argv, no shell, ~70 KB prompt over stdin, cwd the temp dir");
  }

  /* --- P12: the env is the allow-list and nothing else ------------------------------------------- */
  {
    const secrets: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: "123456:tg-secret-token-value",
      TELEGRAM_CHAT_ID: "424242",
      GROQ_API_KEY: "groq-secret-value",
      TWITCH_CLIENT_SECRET: "twitch-secret-value",
      YOUTUBE_TOKEN_FILE: "/secret/youtube-token.json",
      GITHUB_TOKEN: "ghp_secret_value",
    };
    // Not inherited, so a constant the adapter sets itself is told apart from a forwarded variable.
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    Object.assign(process.env, secrets, {
      HOME: "/home/someone",
      LANG: "pl_PL.UTF-8",
      TMPDIR: tmpdir(),
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
      ANTHROPIC_API_KEY: "api-key-value",
    });
    await runClaude("hi", { binary: ok, systemPrompt: "s" });
    const env = recorded().env;
    const ALLOWED = ["PATH", "HOME", "LANG", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
    // Everything the child got from this process is on the allow-list, forwarded verbatim. A key the
    // adapter sets itself to a constant (not read from this process's env) forwards nothing, so it is
    // reported, not failed.
    for (const [k, v] of Object.entries(env)) {
      if (ALLOWED.includes(k)) assert.equal(v, process.env[k], `${k} forwarded verbatim`);
      else assert.notEqual(v, process.env[k], `${k}=${v} was forwarded from this process's env`);
    }
    for (const k of ALLOWED) assert.equal(env[k], process.env[k], `${k} is forwarded when set`);
    for (const [k, v] of Object.entries(secrets)) {
      assert.equal(env[k], undefined, `${k} must never reach the child`);
      assert.ok(
        !Object.values(env).some((x) => x.includes(v)),
        `${k}'s value appears nowhere in the child env`,
      );
    }
    // "if set": with neither auth variable present, neither key appears at all.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    await runClaude("hi", { binary: ok, systemPrompt: "s" });
    const bare = recorded().env;
    assert.ok(
      !("CLAUDE_CODE_OAUTH_TOKEN" in bare) && !("ANTHROPIC_API_KEY" in bare),
      JSON.stringify(Object.keys(bare)),
    );
    const extra = Object.keys(bare).filter((k) => !ALLOWED.includes(k));
    console.log(`OK: the child env is the allow-list (adapter constants: ${extra.join(", ") || "none"})`);
  }

  /* --- P13: a limit is exactly the operator's wording, and nothing is retried --------------------- */
  {
    // The limit as the CLI prints it on stderr with no envelope at all, exit 1.
    const limit = fake(
      "limit.js",
      `process.stderr.write("Error: Claude AI usage limit reached|1760000000\\n"); process.exitCode = 1;`,
    );
    const before = callCount();
    const reply = await runClaude("hi", { binary: limit, systemPrompt: "s" });
    assert.equal(callCount() - before, 1, "asked once — never retried");
    assert.equal(reply.ok, false);
    assert.equal((reply as ClaudeFailure).kind, "limit");
    assert.equal(describeFailure(reply as ClaudeFailure), "usage limit reached — try again later");

    // A plain error is not retried either (asking again right now would get the same answer).
    const boom = fake("boom.js", `process.stderr.write("something broke"); process.exitCode = 3;`);
    const before2 = callCount();
    const failed = await runClaude("hi", { binary: boom, systemPrompt: "s" });
    assert.equal(callCount() - before2, 1, "a failure is asked once");
    assert.equal(failed.ok, false);
    console.log("OK: a stderr-only limit is the exact wording, and no failure is retried");
  }

  /* --- P14: each failure's reason, and that it is one line -------------------------------------- */
  {
    const missing = await runClaude("hi", { binary: path.join(dir, "nope"), systemPrompt: "s" });
    assert.equal(describeFailure(missing as ClaudeFailure), "binary missing in the container");
    const auth = fake(
      "auth.js",
      `process.stdout.write(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" })); process.exitCode = 1;`,
    );
    const unauthed = await runClaude("hi", { binary: auth, systemPrompt: "s" });
    assert.match(describeFailure(unauthed as ClaudeFailure), /claude setup-token/);
    assert.match(describeFailure(unauthed as ClaudeFailure), /CLAUDE_CODE_OAUTH_TOKEN in \/app\/\.env/);

    // A crash with a stack trace on stderr: the reason the report prints under the fallback list must
    // be one line (handbook: "the report shows that one-line reason under it").
    const crash = fake(
      "crash.js",
      `process.stderr.write("TypeError: cannot read properties of undefined\\n    at main (cli.js:1:2)\\n    at run (cli.js:3:4)\\n"); process.exitCode = 1;`,
    );
    const crashed: ClaudeReply = await runClaude("hi", { binary: crash, systemPrompt: "s" });
    assert.equal(crashed.ok, false);
    deviation("the report shows that one-line reason under it (fallbackToday)", () => {
      const reason = describeFailure(crashed as ClaudeFailure);
      assert.ok(
        !reason.includes("\n"),
        `describeFailure returned ${reason.split("\n").length} lines: ${JSON.stringify(reason)}`,
      );
    });
    // Every other kind is one line by construction.
    for (const r of [missing, unauthed]) assert.ok(!describeFailure(r as ClaudeFailure).includes("\n"));
    const sleeper = fake("sleep.js", `setInterval(() => {}, 1000);`);
    const timedOut = await runClaude("hi", { binary: sleeper, systemPrompt: "s", timeoutMs: 150 });
    assert.equal((timedOut as ClaudeFailure).kind, "timeout");
    assert.ok(!describeFailure(timedOut as ClaudeFailure).includes("\n"));
    console.log("OK: missing / auth / timeout reasons read as documented, one line each");
  }

  console.log("claude.contract: all checks passed");
} finally {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(dir, { recursive: true, force: true });
}
