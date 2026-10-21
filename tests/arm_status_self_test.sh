#!/usr/bin/env bash
# Does `arm-session.sh status` answer "am I in tmux?" for THIS session only, from its own shell?
#
# WHY THIS EXISTS (row N42, M312 cold run #11, River/plans/m312-runs/2026-10-21r11-claude-code-opus-prod.md).
# The agent could not read $TMUX, so it read the shared ~/.claude/.lifecycle/lifecycle.log, took
# ANOTHER session's `tmux=y pane=%0` line for its own, and told the human "you are in tmux" when they
# were not. `status` outside a pane used to exit 1 with the same error as `on`, so it gave the agent
# nothing to quote. It must answer plainly, exit 0, and never be swayed by the log.
#
#   bash tests/arm_status_self_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARM="$REPO/providers/claude/scripts/arm-session.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/.claude/.lifecycle"
# A sibling session's line, exactly the shape r11 misread.
printf '%s\n' "2026-10-21T16:30:00Z HOOK sid=4711984d src=startup tmux=y pane=%0 autosend=none" > "$T/.claude/.lifecycle/lifecycle.log"
nomux() { env -u TMUX -u TMUX_PANE -u WTMUX_PID -u WTMUX_PANE -u KIJITO_AUTOCATCHUP HOME="$T" bash "$ARM" "$@" 2>&1; }

echo "arm-session.sh status:"
out=$(nomux status); rc=$?
[ "$rc" = 0 ] && grn "outside any pane: exit 0 (status reports, it does not fail)" || red "outside any pane: rc=$rc"
grep -q '^in_tmux=no' <<<"$out" && grn "outside any pane: says in_tmux=no" || red "no in_tmux=no line: $out"
grep -q 'in_tmux=yes' <<<"$out" && red "swayed by another session's log line: $out" || grn "another session's 'tmux=y pane=%0' log line is ignored"
grep -q 'not armed' <<<"$out" && grn "outside any pane: says not armed" || red "does not say not armed: $out"

out=$(nomux on); rc=$?
[ "$rc" = 1 ] && grep -q 'not in tmux or wtmux' <<<"$out" && grn "'on' outside a pane still refuses (rc 1)" || red "'on' outside a pane: rc=$rc $out"

out=$(env -u TMUX -u WTMUX_PID -u WTMUX_PANE -u KIJITO_AUTOCATCHUP TMUX_PANE=%7 HOME="$T" bash "$ARM" status 2>&1); rc=$?
[ "$rc" = 0 ] && grep -q '^in_tmux=yes pane=%7' <<<"$out" && grn "inside pane %7: says in_tmux=yes pane=%7, from its own shell" \
  || red "inside a pane: rc=$rc $out"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
