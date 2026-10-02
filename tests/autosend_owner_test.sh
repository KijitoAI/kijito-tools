#!/usr/bin/env bash
# Row M437: the post-/clear autosend must fire only for the Claude Code process that OWNS the armed pane.
#
# WHY THIS EXISTS. river measured it 2026-10-02 (lifecycle.log 18:52-18:53 local): a subagent in river's
# armed pane %0 ran headless `claude -p` sessions. Each inherited TMUX_PANE=%0, so each one's
# SessionStart hook saw arm.%0 and AUTOSENT the catch-up prompt into river's LIVE conversation, once per
# headless session (four AUTOSEND_FIRE lines for four different session ids).
#
# Not by session id: /clear ROTATES CLAUDE_CODE_SESSION_ID, and the post-/clear session is exactly the one
# that must autosend. The property that survives /clear: the pane's own claude holds the pane's TERMINAL
# (its controlling tty is #{pane_tty}). A claude started from a tool shell has none (Claude Code's Bash tool
# shells run with no controlling tty - measured on the VM seat), and `-p`/`--print` is headless by definition.
#
# This runs the REAL hook under a REAL tmux pane, as the child of a stand-in `claude` - the shape the harness
# gives it - and reads the hook's own decision from lifecycle.log. The kill switch is set so the detached
# sender never types into anything; the HOOK line is written before the sender runs.
#
#   bash tests/autosend_owner_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SD="$REPO/providers/claude/scripts"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v tmux >/dev/null 2>&1 || { echo "SKIP: tmux not installed."; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed - the hook parses its stdin with jq."; exit 0; }

T="$(mktemp -d)"; S="m437_$$"
trap 'tmux kill-session -t "$S" 2>/dev/null; rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/home" "$T/proj" "$T/lc"
: > "$T/lc/STOP"   # the sender exits at once; only the hook's decision is under test
echo tester > "$T/proj/.kijito_persona"

# A stand-in for Claude Code: its argv carries the flags, and it runs the SessionStart hook as its child.
cat > "$T/claude" <<EOF
#!/usr/bin/env bash
printf '{"source":"clear","cwd":"%s"}' "$T/proj" | bash "$SD/session-catchup-hint.sh" >/dev/null 2>&1
EOF
chmod +x "$T/claude"
# What runs in the pane: arm it, then play each kind of claude in turn.
_setsid=""; command -v setsid >/dev/null 2>&1 && _setsid=1
cat > "$T/pane.sh" <<EOF
#!/usr/bin/env bash
export HOME="$T/home" KIJITO_LC_DIR="$T/lc" KIJITO_LC_STOP="$T/lc/STOP" CLAUDE_PROJECT_DIR="$T/proj"
unset KIJITO_AUTOCATCHUP
bash "$SD/arm-session.sh" on > "$T/arm.out" 2>&1
echo "--- owner"            >> "$T/lc/lifecycle.log"; bash "$T/claude" --model opus
echo "--- print-flag"       >> "$T/lc/lifecycle.log"; bash "$T/claude" -p "do a thing"
echo "--- print-long"       >> "$T/lc/lifecycle.log"; bash "$T/claude" --print "do a thing"
if [ -n "$_setsid" ]; then
  echo "--- no-tty"         >> "$T/lc/lifecycle.log"; setsid -w bash "$T/claude" --model opus < /dev/null
fi
echo done > "$T/done"
sleep 30
EOF
chmod +x "$T/pane.sh"
tmux new-session -d -s "$S" -x 120 -y 30 "bash '$T/pane.sh'"
for _ in $(seq 1 100); do [ -f "$T/done" ] && break; sleep 0.1; done
[ -f "$T/done" ] || { red "the pane script never finished: $(cat "$T/arm.out" 2>/dev/null)"; echo; echo "passed: $pass   failed: $fail"; exit 1; }
grep -q "AUTONOMY ON" "$T/arm.out" || red "could not arm the test pane: $(cat "$T/arm.out")"

# The HOOK line written after each "--- <case>" marker.
verdict() { awk -v c="--- $1" '$0==c{f=1;next} /^--- /{f=0} f && / HOOK /' "$T/lc/lifecycle.log"; }

echo "autosend fires only for the pane's own interactive claude (M437):"
v=$(verdict owner)
if grep -q "autosend=ARMED" <<<"$v"; then grn "the pane's own claude (holds the pane tty) still autosends - the self-clear loop is intact"
else red "the pane owner no longer autosends: ${v:-<no HOOK line>}"; fi
for c in print-flag print-long; do
  v=$(verdict $c)
  if grep -q "autosend=ARMED" <<<"$v"; then red "a headless claude ($c) in an armed pane AUTOSENDS into the live session: $v"
  elif grep -q "autosend=SKIPPED.*not-pane-owner" <<<"$v"; then grn "a headless claude ($c) is skipped, and the log says why"
  else red "$c: unexpected hook verdict: ${v:-<no HOOK line>}"; fi
done
if [ -n "$_setsid" ]; then
  v=$(verdict no-tty)
  if grep -q "autosend=ARMED" <<<"$v"; then red "a claude with no controlling tty (a tool-shell child) AUTOSENDS: $v"
  elif grep -q "autosend=SKIPPED.*not-pane-owner" <<<"$v"; then grn "a claude with no controlling tty (a tool-shell child, no -p) is skipped"
  else red "no-tty: unexpected hook verdict: ${v:-<no HOOK line>}"; fi
else echo "  skip  no setsid on this host - the no-tty case is covered on Linux CI"; fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
