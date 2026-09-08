#!/usr/bin/env python3
"""Run a command as a child subreaper and reap everything it orphans.

PID 1 in this container is `sleep infinity`, which never calls wait(), so every process a
Playwright run leaves behind (chrome-headless-shell's gpu/utility/renderer children when the
browser exits first) becomes a zombie forever — 5,000+ of them after one review, against a
pids cgroup limit of 9,186. With PR_SET_CHILD_SUBREAPER those orphans are reparented here
instead and reaped. Usage: python3 reap.py node script.cjs args...
"""
import ctypes, os, signal, subprocess, sys, time

PR_SET_CHILD_SUBREAPER = 36
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    sys.stderr.write("reap.py: prctl failed, running without a subreaper\n")

child = subprocess.Popen(sys.argv[1:])
code = None
while True:
    try:
        pid, status = os.wait()
    except ChildProcessError:
        break
    if pid == child.pid:
        code = status
        # the command is done; give its orphans a moment to exit, reap them, then leave
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                p, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if p == 0:
                time.sleep(0.1)
        # anything still alive after the grace period is killed and reaped
        try:
            while True:
                p, _ = os.waitpid(-1, os.WNOHANG)
                if p == 0:
                    for line in os.popen("ps -eo pid,ppid").read().split("\n")[1:]:
                        parts = line.split()
                        if len(parts) == 2 and int(parts[1]) == os.getpid():
                            os.kill(int(parts[0]), signal.SIGKILL)
                    time.sleep(0.2)
        except ChildProcessError:
            pass
        break
sys.exit(os.waitstatus_to_exitcode(code) if code is not None else 1)
