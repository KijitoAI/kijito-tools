#!/usr/bin/env bash
# kijito-start must treat a live consumer for the same persona in ANY session as "the inbox is watched":
# arm nothing, ask the human for nothing.
#
# THE FAILURE THIS PREVENTS. Session 2 runs `pgrep` and finds session 1's live `tail -n 0 -F …events.heidi.ndjson`.
# Wording that says one line means "already armed by a session before the /clear" does not describe a
# consumer from ANOTHER session, and a "RUNNING IS NOT ARMED — verify the wake path" bullet can send the
# agent off to inspect that process. If the inspection is denied, the agent arms a second Monitor (also
# denied) and tells the human "Inbox alerts aren't on … approve the command". The stream may also live in
# ~/.local/state/kijito-inbox-monitor/, a layout the skill's find-your-stream step must list.
# The hook half is pinned in catchup_topology_test.sh (block E).
#
#   bash tests/kijito_start_watched_test.sh              # run the checks
#   bash tests/kijito_start_watched_test.sh --mutation   # ALSO prove the checks can fail
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_DEFAULT="$REPO/providers/claude/skills/kijito-start/SKILL.md"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

check_skill() {
  local f=$1 bad=0
  grep -qF 'your inbox is already watched. Arm nothing, and ask the human for nothing.' "$f" \
    && grn "one live consumer → watched, arm nothing, ask nothing" \
    || { red "one live consumer is not stated as watched / arm nothing / ask nothing"; bad=1; }
  grep -qF 'ANOTHER session of the same persona' "$f" \
    && grn "the rule covers a consumer from ANOTHER session, not only a pre-/clear one" \
    || { red "the rule still reads as pre-/clear only"; bad=1; }
  grep -qF "never \"alerts aren't on\"" "$f" \
    && grn "the human is never told alerts are off while a consumer is live" \
    || { red "no guard against telling the human alerts are off"; bad=1; }
  grep -qF 'that is **not** a reason to arm a second one' "$f" \
    && grn "a denied or failed inspection of another session's consumer is not a reason to arm" \
    || { red "the verify-the-wake-path bullet still invites arming when inspection fails"; bad=1; }
  grep -qF '~/.local/state/kijito-inbox-monitor/events.<P>.ndjson' "$f" \
    && grn "find-your-stream lists the XDG-state layout" \
    || { red "find-your-stream misses ~/.local/state/kijito-inbox-monitor/"; bad=1; }
  ! grep -qF 'already armed by a session before the `/clear`; **do not start another.**' "$f" \
    && grn "the old pre-/clear-only wording is gone" \
    || { red "the old pre-/clear-only wording is still there"; bad=1; }
  return $bad
}

echo "kijito-start live-consumer checks:"
check_skill "$SKILL_DEFAULT"

if [ "${1:-}" = "--mutation" ]; then
  echo
  echo "mutation (the earlier pre-/clear-only wording MUST fail the checks above):"
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  python3 - "$SKILL_DEFAULT" "$T/SKILL.md" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
s = re.sub(r"       - \*\*prints one line →\*\*.*\n",
           "       - **prints one line →** already armed by a session before the `/clear`; **do not start another.**\n", s)
s = s.replace(" ⚠️ This check is about a consumer YOU armed. If a consumer from another session is live and you cannot inspect it (for example, the command is denied), that is **not** a reason to arm a second one: report the inbox as watched and move on.", "")
s = s.replace("       ls ~/.local/state/kijito-inbox-monitor/events.<P>.ndjson    # the monitor's own systemd template, or kijito-inbox-start.sh\n", "")
open(sys.argv[2], "w").write(s)
EOF
  p0=$pass f0=$fail
  if check_skill "$T/SKILL.md" >/dev/null; then red "mutation SURVIVED — the checks pass on the old wording"
  else pass=$p0; fail=$f0; grn "mutation killed — the old wording fails the checks"; fi
fi

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
