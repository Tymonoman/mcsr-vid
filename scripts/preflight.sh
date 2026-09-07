#!/usr/bin/env bash
# What would block this session, checked before any work is done.
#
# Silent on success apart from one line: SessionStart output lands in every conversation, and a
# preflight that prints a wall of PASS lines every time is noise people learn to skip.
#
# Nothing here fails the session (always exits 0) and nothing here blocks: every network call is
# bounded by a timeout, because a preflight that hangs is worse than the problems it looks for.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-/app}" 2>/dev/null || exit 0

problems=()

# --- tools the pipeline shells out to. Missing ones surface as a failed render otherwise.
for tool in ffmpeg ffprobe yt-dlp melt-7 xvfb-run node; do
  command -v "$tool" >/dev/null 2>&1 || problems+=("missing: $tool")
done

# --- concurrent work. CLAUDE.md's rule is never to stage on a shared tree; this is how you find
# out you are on one before staging anything.
if [ -d .git ]; then
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" -gt 0 ] && problems+=("$dirty uncommitted file(s) — check for another session's work before staging")
  git remote get-url origin >/dev/null 2>&1 || problems+=("no 'origin' remote configured")
fi

# --- GitHub. Two sessions were lost to credentials, so name the exact state rather than
# discovering it mid-push.
if command -v gh >/dev/null 2>&1; then
  if ! timeout 10 gh auth status >/dev/null 2>&1; then
    problems+=("gh is not authenticated — run: gh auth login --with-token  (needs Contents: Read and write)")
  fi
else
  problems+=("gh not installed — pushes and PRs go through raw git only")
fi

# --- the credential most likely to expire silently. See scripts/preflight-youtube.mjs.
youtube=$(timeout 20 node scripts/preflight-youtube.mjs 2>/dev/null)

if [ ${#problems[@]} -eq 0 ] && [ -z "$youtube" ]; then
  echo "preflight: ok"
else
  echo "preflight: needs attention"
  for p in "${problems[@]}"; do echo "  $p"; done
  [ -n "$youtube" ] && echo "$youtube"
fi
exit 0
