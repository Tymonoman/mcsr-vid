#!/usr/bin/env bash
# Supervises `npm run studio -- worker --enable` (src/youtube/studioWorker.ts): a tiny forever
# loop that restarts it 60s after any exit — a crash, a clean `--once`, or the worker's own clean
# exit when new code is checked out while it sits idle in its nightly blackout (never mid-cycle;
# see CLAUDE.md "Studio automation") — logging every line to ~/.claude/studio-worker.log. Safe to
# start twice: a pidfile refuses a second supervisor while the first still holds it.
#
# Start (the one line; CLAUDE.md names it too):
#   nohup bash /app/scripts/studio-worker.sh >/dev/null 2>&1 &
set -uo pipefail

ROOT="${STUDIO_WORKER_ROOT:-/app}"
LOG="$HOME/.claude/studio-worker.log"
LOCK="$HOME/.claude/studio-worker-supervisor.pid"
export STUDIO_PROFILE_DIR="${STUDIO_PROFILE_DIR:-/app/.studio-profile}"

mkdir -p "$(dirname "$LOG")"

# ponytail: a pidfile, not a real flock — one supervisor on one box is the only case that
# matters here; upgrade to flock(1) if this ever runs on more than one host against the same
# profile. A dead pid left over from a crashed supervisor is not a lock at all — and nor is a
# live one some fresh container boot has already reused for an unrelated process: ~/.claude is
# the only persisted volume in this container (CLAUDE.md), so a pidfile a SIGKILL'd supervisor
# left behind outlives the low PID numbers a fresh container hands out to whatever starts first,
# the exact hazard src/dashboard/studioLogin.ts's own killOrphanedLoginScreen already guards
# against with the same /proc/<pid>/cmdline check — never trust a pid on a guess.
pid_is_this_script() {
  grep -qa "studio-worker\.sh" "/proc/$1/cmdline" 2>/dev/null
}

if [ -f "$LOCK" ]; then
  old_pid="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null && pid_is_this_script "$old_pid"; then
    echo "studio-worker supervisor already running (pid $old_pid)" >&2
    exit 1
  fi
fi
echo "$$" >"$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Overridable by a test, so the loop/lock/log behaviour below runs in well under a second against
# a fake command instead of a real npm/Chrome session.
# shellcheck disable=SC2206
cmd=(${STUDIO_WORKER_CMD:-npm run -s studio -- worker --enable})
delay="${STUDIO_WORKER_RESTART_DELAY:-60}"

while true; do
  {
    echo "$(date -u +%FT%TZ) starting: ${cmd[*]}"
    (cd "$ROOT" && "${cmd[@]}")
    echo "$(date -u +%FT%TZ) exited $? — restarting in ${delay}s"
  } >>"$LOG" 2>&1
  sleep "$delay"
done
