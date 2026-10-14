// Pure shell-script self-check for scripts/studio-worker.sh: the pidfile lock (safe to start
// twice) and the restart-after-exit loop. Every run below gets its own sandboxed $HOME and a fake
// STUDIO_WORKER_CMD, so nothing here ever touches the real ~/.claude/studio-worker.log or
// /app/.studio-profile a live worker may be holding.
// Run: npx tsx scripts/studio-worker.test.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(new URL(".", import.meta.url).pathname, "studio-worker.sh");

function sandboxHome(): { home: string; log: string; lock: string } {
  const home = mkdtempSync(path.join(tmpdir(), "mcsr-studio-sup-"));
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  return {
    home,
    log: path.join(home, ".claude", "studio-worker.log"),
    lock: path.join(home, ".claude", "studio-worker-supervisor.pid"),
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The supervisor cd's into STUDIO_WORKER_ROOT (default /app) before each start. A runner with no
// /app (GitHub's, 14 Oct 2026) logs "cd: /app: No such file or directory" and the line-shape check
// below trips, so every run points it at its own sandbox.
const envFor = (home: string, extra: Record<string, string>) => ({
  ...process.env,
  HOME: home,
  STUDIO_WORKER_ROOT: home,
  ...extra,
});

// --- a real first instance (matching cmdline) still running refuses a second start -------------
{
  const { home, lock, log } = sandboxHome();
  const first = spawn("bash", [SCRIPT], {
    env: envFor(home, { STUDIO_WORKER_CMD: "sleep 20", STUDIO_WORKER_RESTART_DELAY: "60" }),
  });
  for (let i = 0; i < 50 && !existsSync(lock); i++) await sleepMs(100);
  assert.ok(existsSync(lock), "the first instance wrote its own pid into the lock file");

  const result = spawnSync("bash", [SCRIPT], {
    env: envFor(home, { STUDIO_WORKER_CMD: "true" }),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, "a second start refuses while a real first instance still holds the lock");
  assert.match(result.stderr, /already running/i);
  assert.equal(
    (readFileSync(log, "utf8").match(/starting:/g) ?? []).length,
    1,
    "only the first instance's own loop ever started — the second start never ran its command",
  );
  first.kill("SIGKILL");
  console.log(
    "OK: a second start refuses while a real first instance (matching cmdline) still holds the lock",
  );
}

// --- a live pid that is NOT running this script does not block a new start ---------------------
// (the hazard this guards against: ~/.claude is the only persisted volume in this container, so a
// pidfile a SIGKILL'd supervisor left behind outlives the low pid numbers a fresh container hands
// out to whatever starts first — the same reason src/dashboard/studioLogin.ts's own
// killOrphanedLoginScreen checks /proc/<pid>/cmdline before ever trusting a recorded pid.)
{
  const { home, lock, log } = sandboxHome();
  const decoy = spawn("sleep", ["20"]); // alive, but its cmdline has nothing to do with this script
  for (let i = 0; i < 20 && !decoy.pid; i++) await sleepMs(50);
  writeFileSync(lock, String(decoy.pid));
  const result = spawnSync("bash", [SCRIPT], {
    env: envFor(home, { STUDIO_WORKER_CMD: "true", STUDIO_WORKER_RESTART_DELAY: "60" }),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(
    result.status,
    1,
    "a live pid that isn't this script must not be read as a running supervisor",
  );
  assert.ok(existsSync(log) && readFileSync(log, "utf8").includes("starting:"), "the loop actually started");
  decoy.kill();
  console.log("OK: a live pid reused by an unrelated process does not block a new start (cmdline-checked)");
}

// --- a stale lock (a pid that is certainly dead) does not block a new start --------------------
{
  const { home, lock } = sandboxHome();
  const dead = spawnSync("true").pid ?? 999_999; // already exited by the time we read its pid
  writeFileSync(lock, String(dead));
  const child = spawn("timeout", ["-s", "KILL", "2", "bash", SCRIPT], {
    env: envFor(home, { STUDIO_WORKER_CMD: "true", STUDIO_WORKER_RESTART_DELAY: "10" }),
  });
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(existsSync(lock), "a stale lock is overwritten with this run's own pid, not left alone");
  console.log("OK: a stale (dead-pid) lock does not block a new start");
}

// --- restarts the command 60s-equivalent after every exit, logs both lines ---------------------
{
  const { home, log } = sandboxHome();
  const child = spawn("timeout", ["-s", "KILL", "4", "bash", SCRIPT], {
    env: envFor(home, {
      STUDIO_WORKER_CMD: "true", // exits 0 immediately — no real npm/Chrome ever touched
      STUDIO_WORKER_RESTART_DELAY: "1", // stand-in for the real 60s so the test takes ~4s, not minutes
    }),
  });
  await new Promise((resolve) => child.on("exit", resolve));

  const lines = readFileSync(log, "utf8").trim().split("\n");
  const starts = lines.filter((l) => l.includes("starting:")).length;
  const exits = lines.filter((l) => l.includes("exited 0")).length;
  assert.ok(
    starts >= 2,
    `expected at least 2 restarts in ~4s at a 1s delay, got ${starts}: ${lines.join(" | ")}`,
  );
  assert.equal(exits, starts, "every start this ran long enough to see also logged its own exit");
  assert.ok(
    lines.every((l) => /starting:|exited \d+ — restarting/.test(l)),
    `only the loop's own two line shapes, got: ${lines.join(" | ")}`,
  );
  console.log(`OK: the command is restarted after every exit (${starts} cycles logged in ~4s at a 1s delay)`);
}

// --- STUDIO_PROFILE_DIR defaults to /app/.studio-profile and an override is passed through -----
{
  const { home: home1, log: log1 } = sandboxHome();
  const c1 = spawn("timeout", ["-s", "KILL", "2", "bash", SCRIPT], {
    env: envFor(home1, { STUDIO_WORKER_CMD: "env", STUDIO_WORKER_RESTART_DELAY: "10" }),
  });
  await new Promise((resolve) => c1.on("exit", resolve));
  assert.match(readFileSync(log1, "utf8"), /^STUDIO_PROFILE_DIR=\/app\/\.studio-profile$/m);

  const { home: home2, log: log2 } = sandboxHome();
  const c2 = spawn("timeout", ["-s", "KILL", "2", "bash", SCRIPT], {
    env: envFor(home2, {
      STUDIO_WORKER_CMD: "env",
      STUDIO_WORKER_RESTART_DELAY: "10",
      STUDIO_PROFILE_DIR: "/tmp/a-different-profile",
    }),
  });
  await new Promise((resolve) => c2.on("exit", resolve));
  assert.match(readFileSync(log2, "utf8"), /^STUDIO_PROFILE_DIR=\/tmp\/a-different-profile$/m);
  console.log("OK: STUDIO_PROFILE_DIR defaults to /app/.studio-profile and an override reaches the command");
}

console.log("studio-worker.sh: all checks passed");
