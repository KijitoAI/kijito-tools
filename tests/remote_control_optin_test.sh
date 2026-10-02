#!/usr/bin/env bash
# Row M441: an armed launch must not turn on Remote Control unless the human opted in.
#
# WHY THIS EXISTS. claude-armed.sh passed --remote-control by DEFAULT (opt-out via KIJITO_REMOTE_CONTROL=0),
# and nothing in setup said so. In the M312 Sonnet cold run (2026-10-02, river 11324) an answer the human
# stand-in never gave reached the armed pane: Remote Control is one more thing that can type into a pane,
# and a stranger was never told it was on. So it is opt-IN, and when it is on the launch says so.
#
# Runs the REAL launcher with a stand-in `claude` that records the argv it was given.
#
#   bash tests/remote_control_optin_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARMED="$REPO/providers/claude/scripts/claude-armed.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/bin" "$T/home/.claude" "$T/proj"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/argv"\n' "$T" > "$T/bin/claude"; chmod +x "$T/bin/claude"
echo tester > "$T/proj/.kijito_persona"
launch() {  # extra env as args; prints the launcher's stderr; the stand-in's argv lands in $T/argv
  : > "$T/argv"
  ( cd "$T/proj" && env -u TMUX -u TMUX_PANE -u WTMUX_PANE -u WTMUX_PID -u KIJITO_REMOTE_CONTROL -u KIJITO_RC_PREFIX \
      HOME="$T/home" PATH="$T/bin:$PATH" KIJITO_LC_DIR="$T/lc" CLAUDE_PROJECT_DIR="$T/proj" "$@" bash "$ARMED" 2>&1 >/dev/null )
}

echo "Remote Control is opt-in on an armed launch (M441):"
err=$(launch)
[ -s "$T/argv" ] || red "the stand-in claude was never launched - this check measured nothing"
if grep -qx -- '--remote-control' "$T/argv"; then red "default armed launch turns Remote Control ON: $(tr '\n' ' ' < "$T/argv")"
else grn "default armed launch: no --remote-control"; fi
if grep -qi 'remote control' <<<"$err"; then red "the default launch talks about Remote Control as if it were on: $err"
else grn "default launch says nothing about a Remote Control it did not enable"; fi

err=$(launch KIJITO_REMOTE_CONTROL=1)
if grep -qx -- '--remote-control' "$T/argv" && grep -qx -- 'tester' "$T/argv"; then
  grn "KIJITO_REMOTE_CONTROL=1 opts in, with the persona as the session-name prefix"
else red "opt-in did not enable Remote Control with the prefix: $(tr '\n' ' ' < "$T/argv")"; fi
if grep -qi 'remote control is ON' <<<"$err"; then grn "an opted-in launch says Remote Control is on, on stderr"
else red "an opted-in launch is silent about Remote Control: ${err:-<nothing>}"; fi

# Fail CLOSED on anything but exactly "1" (river's 0.2.12 review, LOW-2): an empty value and a "truthy"
# word must both keep it off, with no ON line - a mutant "anything but 0 = on" passed the first version.
for v in "" true yes; do
  err=$(launch KIJITO_REMOTE_CONTROL="$v")
  if grep -qx -- '--remote-control' "$T/argv" || grep -qi 'remote control is ON' <<<"$err"; then
    red "KIJITO_REMOTE_CONTROL='$v' turned Remote Control on (only exactly 1 opts in)"
  else grn "KIJITO_REMOTE_CONTROL='$v' keeps it off, with no ON line"; fi
done

err=$(launch KIJITO_REMOTE_CONTROL=0)
if grep -qx -- '--remote-control' "$T/argv"; then red "KIJITO_REMOTE_CONTROL=0 still enables it"
else grn "KIJITO_REMOTE_CONTROL=0 keeps it off (the old opt-out still works)"; fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
