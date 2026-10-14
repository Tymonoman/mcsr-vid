#!/usr/bin/env bash
# Full coverage, ready matches and writers too: `node stub-server.cjs capture http://mcsr-dashboard:8080 <dir>`, serve it with `STUB_READY=2 STUB_FIXTURES=<dir> PORT=8097 node stub-server.cjs`, then `SCRATCH=1 run-all.sh http://127.0.0.1:8097`.
# Drive the dashboard in a real browser the way the operator does. Usage:
#   bash scripts/browser-checks/run-all.sh http://127.0.0.1:8093
# Needs `npx playwright install chromium firefox` once, and a server on that URL with real match data.
# hook-flow and now-flow press Save, which schedules real uploads now: both answer the Short
# routes in the browser, so nothing reaches the server. publish-at lets only GETs through at all.
# Four checks write on the server itself: round1-fixes (dismisses and restores a suggestion),
# settings-check (saves a setting, puts it back), inline-errors and sync-edit (send writes the
# server must refuse). They run only with SCRATCH=1, which says the URL is the stub
# (stub-server.cjs) or a test dashboard on a scratch MCSR_CONFIG -- never mcsr-dashboard:8080.
set -u
BASE="${1:?usage: [SCRATCH=1] run-all.sh <dashboard url>}"
case "$BASE" in *:8080*) [ "${SCRATCH:-0}" = 1 ] && { echo "SCRATCH=1 is for a stub or test server, not $BASE"; exit 2; } ;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
# `published` is a Studio upload -- one the channel scan paired by its description, with no
# youtube.json -- because studio-upload-check is about exactly that; since the dashboard's own
# uploads began (15 Sept) the newest uploaded match is usually not one.
pick() { curl -s "$BASE/api/matches" | python3 -c "
import json,sys,urllib.request; ms=json.load(sys.stdin)['matches']
want=sys.argv[1]
studio=set()
if want=='published':
    try:
        ups=json.load(urllib.request.urlopen(sys.argv[2]+'/api/youtube/uploads'))['uploads']
        studio={u['matchId'] for u in ups if u.get('source') in ('studio','channel')}
    except Exception: pass
for m in ms:
    if want=='ready' and m['exported'] and not m['uploaded'] and not m['hidden']: print(m['matchId']); break
    if want=='ready2' and m['exported'] and not m['uploaded'] and not m['hidden']: want='ready2b'; continue
    if want=='ready2b' and m['exported'] and not m['uploaded'] and not m['hidden']: print(m['matchId']); break
    if want=='published' and m['uploaded'] and not m['hidden'] and (not studio or m['matchId'] in studio): print(m['matchId']); break
    if want=='unexported' and not m['exported'] and not m['hidden']: print(m['matchId']); break
    if want=='scheduled' and m.get('shortState')=='scheduled' and not m['hidden']: print(m['matchId']); break
" "$1" "$BASE"; }
READY="$(pick ready)"; READY2="$(pick ready2)"; PUBLISHED="$(pick published)"; UNEXPORTED="$(pick unexported)"
SCHEDULED="$(pick scheduled)"
echo "ready=$READY ready2=$READY2 published=$PUBLISHED unexported=$UNEXPORTED scheduled=$SCHEDULED"
fail=0
# A check whose fixture match this server has none of is skipped, not failed (the live server
# rarely has a ready match: the nightly renders at 03:00 UTC and the chain uploads that day).
# `need ready,published run x …` checks READY and PUBLISHED; the other checks find their own match.
need() { local w v; for w in ${1//,/ }; do v=${w^^}; [ -n "${!v}" ] || { echo "SKIP $3 (no $w match on this server)"; return; }; done; shift; "$@"; }
scratch() { if [ "${SCRATCH:-0}" = 1 ]; then run "$@"; else echo "SKIP $1 (writes on the server: SCRATCH=1 on a stub or test server)"; fi; }
# Exit 3 is a check's own skip (nothing here to drive), its reason the log's last line.
run() {
  local name="$1" log="${TMPDIR:-/tmp}/bc-$1.log"; shift; node "$HERE/$name.cjs" "$@" >"$log" 2>&1
  case $? in 0) echo "PASS $name" ;; 3) echo "SKIP $name ($(tail -1 "$log"))" ;; *) echo "FAIL $name (see $log)"; fail=1 ;; esac
}
run smoke "$BASE"
run version-check "$BASE"
run matches-fail-check "$BASE"
run runnow-fail-check "$BASE"
run sugg-fail-check "$BASE"
need ready run kit-scan-check "$BASE" "$READY"
scratch round1-fixes-check "$BASE" "$READY"
run round3-check "$BASE" "$READY"
need ready run round4-check "$BASE" "$READY"
need ready run pinned-check "$BASE" "$READY"
need ready run pull-kit-check "$BASE" "$READY"
run abtab-check "$BASE"
run playoffs-fold-check "$BASE"
need ready run post-audit-check "$BASE" "$READY" "$PUBLISHED"
scratch settings-check "$BASE"
scratch inline-errors-check "$BASE"
need ready scratch sync-edit-check "$BASE" "$READY"
run phone-rows-check "$BASE"
run deep-link-check "$BASE"
need ready2 run hook-flow-check "$BASE" "$READY2"
run now-flow-check "$BASE" "$READY" "$READY2"
run pick-progress-check "$BASE" "$READY"
need ready run checkchannel-check "$BASE" "$READY"
# Firefox too (npx playwright install firefox). Its Save, Move and by-hand upload are answered in the
# browser and every other non-GET is aborted and failed: nothing it does is written on the server.
need ready run publish-at-check "$BASE" "$READY" "$READY2" "$SCHEDULED" "$PUBLISHED"
need published run studio-upload-check "$BASE" "$PUBLISHED"
need ready2,unexported run stale-preview "$BASE" "$READY2" "$UNEXPORTED"
exit $fail
