#!/usr/bin/env bash
# Hand an easy, fully specified repo task to agy (Gemini, on the operator's subscription) so a
# Claude session spends its tokens on the review, not the typing. agy works in a fresh worktree on
# branch agy/<name> with its own home (/app/.tools/agy-dev: ECC, ponytail, /watch and the Claude
# skills installed; write access to .claude/worktrees only; no commit, push or rm). The caller
# reads the diff, runs the tests and commits — nothing agy writes reaches main unreviewed.
#
#   bash scripts/agy-task.sh <name> <prompt-file> [model]    (default gemini-3.8-flash-high)
#
# The picker's home (/app/.tools/agy-home) stays plugin-free: every Short pick would carry them.
# No --sandbox: in this container it cannot exec at all ("fork/exec … operation not permitted")
# and the model just sets BypassSandbox — the allowlist in agy-dev's settings.json is the guard.
# A command outside it (a for loop, a pipe) is auto-denied and ends the run with an empty answer,
# which is why the prompt names the allowed commands.
set -euo pipefail
name=$1 prompt=$2 model=${3:-gemini-3.8-flash-high}
wt=/app/.claude/worktrees/agy-$name
out=/app/.tools/agy-dev/runs/$name.json
mkdir -p "$(dirname "$out")"
# A second run of the same name (a retry with a better prompt) continues in the same worktree.
[ -d "$wt" ] || { git -C /app worktree add -q "$wt" -b "agy/$name" main && ln -s /app/node_modules "$wt/node_modules"; }
cd "$wt"
agy() { HOME=/app/.tools/agy-dev /app/.tools/bin/agy "$@" --model "$model" --mode accept-edits --output-format json --print-timeout 1800s; }
field() { python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); print(j.get(sys.argv[2]) or "")' "$out" "$1" 2>/dev/null; }
agy -p "You are working in the git worktree $wt (branch agy/$name) of the mcsr-vid repo.
Rules: read CLAUDE.md there first; edit files only inside $wt; do not commit, push or delete branches;
match the surrounding code's style; when done run npm run typecheck and npm run test:unit and report both.
Shell: only these single commands are allowed — git status/diff/log/show/grep, grep, ls, cat, head, tail,
wc, npx tsx <file>, npx prettier, npx tsc --noEmit, npm run typecheck, npm run test:unit. No globs (*), loops,
pipes, &&, ; or redirects: anything else is refused and ends your turn with nothing done. Prefer your own
file-view and search tools to shell commands. Make the edits before you verify, not after.
Your final answer: what you changed (file by file), the two commands' results, and anything you were unsure of.

TASK:
$(cat "$prompt")" >"$out" || true
# A refused command ends a headless turn with an empty answer; carry on in the same conversation
# (it keeps what it has read) rather than start over.
for _ in 1 2; do
  [ -z "$(field response | tr -d '[:space:]')" ] && [ -n "$(field denied_actions)" ] || break
  agy --conversation "$(field conversation_id)" -p "Your last shell command was refused: only the single commands listed at the start run (no globs, loops, pipes, && or redirects). Carry on with the task using your own file-view and search tools, then give the final answer." >"$out" || true
done
echo "agy done: $out"
git -C "$wt" status --short
