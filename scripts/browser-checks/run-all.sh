#!/usr/bin/env bash
# Drive the dashboard in a real browser the way the operator does. Usage:
#   bash scripts/browser-checks/run-all.sh http://127.0.0.1:8093
# Needs `npx playwright install chromium` once, and a server on that URL with real match data.
# Two checks change state and restore it (hook-flow writes and removes an edited title;
# round1-fixes dismisses and restores a suggestion); rerender-check re-renders thumbnails for
# real and is NOT run here.
set -u
BASE="${1:?usage: run-all.sh <dashboard url>}"
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
" "$1" "$BASE"; }
READY="$(pick ready)"; READY2="$(pick ready2)"; PUBLISHED="$(pick published)"; UNEXPORTED="$(pick unexported)"
echo "ready=$READY ready2=$READY2 published=$PUBLISHED unexported=$UNEXPORTED"
fail=0
run() { local name="$1"; shift; if node "$HERE/$name.cjs" "$@" >/tmp/bc-$name.log 2>&1; then echo "PASS $name"; else echo "FAIL $name (see /tmp/bc-$name.log)"; fail=1; fi; }
run smoke "$BASE"
run version-check "$BASE"
run matches-fail-check "$BASE"
run runnow-fail-check "$BASE"
run sugg-fail-check "$BASE"
run kit-scan-check "$BASE" "$READY"
run round1-fixes-check "$BASE"
run round3-check "$BASE"
run round4-check "$BASE" "$READY"
run pinned-check "$BASE" "$READY"
run pull-kit-check "$BASE" "$READY"
run abtab-check "$BASE"
run playoffs-fold-check "$BASE"
run post-audit-check "$BASE" "$READY" "$PUBLISHED"
run settings-check "$BASE"
run inline-errors-check "$BASE"
run sync-edit-check "$BASE" "$READY"
run phone-rows-check "$BASE"
run hook-flow-check "$BASE" "$READY2"
run short-mismatch-check "$BASE" "$READY"
run seek-moment-check "$BASE" "$READY"
run checkchannel-check "$BASE" "$READY"
[ -n "$PUBLISHED" ] && run studio-upload-check "$BASE" "$PUBLISHED"
[ -n "$UNEXPORTED" ] && run stale-preview "$BASE" "$READY2" "$UNEXPORTED"
exit $fail
