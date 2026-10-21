#!/usr/bin/env bash
# Does --allow-self-clear add exactly the self-clear allow rules, and ONLY when asked? (row M410)
#
# WHY THIS EXISTS. M312 runs on Opus (r10, r11) saw Claude Code's auto-mode classifier refuse
# `arm-session.sh on` ("Tmux Self Drive") and then refuse the agent adding allow rules for it
# ("Self-Modification"). The human's own install may add them instead, but writing permission rules
# is a security-posture change, so the properties that matter are: nothing is written without the
# flag, the rules are exact (no wildcard), existing rules are untouched, and the undo removes exactly
# what was added. This runs the REAL installer against a throwaway HOME.
#
#   bash tests/allow_self_clear_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${KIJITO_TEST_INSTALLER:-$REPO/install.sh}"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the installer requires it."; exit 0; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
inst() { ( cd "$H" && env -u KIJITO_API_TOKEN -u CLAUDE_PROJECT_DIR HOME="$H" bash "$INSTALLER" --allow-branch "$@" 2>&1 ); }
allow() { jq -c '.permissions.allow // "absent"' "$H/.claude/settings.json"; }
mode_of() { m=$(stat -c '%a' "$1" 2>/dev/null); case "$m" in ''|*[!0-7]*) m=$(stat -f '%Lp' "$1");; esac; printf '%s' "$m"; }

echo "--allow-self-clear:"
H="$T/fresh"; mkdir -p "$H"; inst >/dev/null
[ "$(allow)" = '"absent"' ] && grn "no flag, fresh install → no permissions.allow is written" || red "no flag wrote: $(allow)"

H="$T/existing"; mkdir -p "$H/.claude"
printf '{"permissions":{"allow":["Bash(ls)"],"deny":["Bash(rm -rf /)"]}}\n' > "$H/.claude/settings.json"; chmod 0600 "$H/.claude/settings.json"
inst >/dev/null
[ "$(allow)" = '["Bash(ls)"]' ] && grn "no flag → existing permissions.allow left exactly as it was" || red "no flag changed allow: $(allow)"

out=$(inst --allow-self-clear)
want=$(jq -nc --arg h "$H/.claude" '["Bash(ls)"] + ([
  "~/.claude/arm-session.sh on","~/.claude/arm-session.sh off","~/.claude/arm-session.sh status",
  "~/.claude/kijito-qa-pass.sh","~/.claude/self-clear.sh",
  ($h+"/arm-session.sh on"),($h+"/arm-session.sh off"),($h+"/arm-session.sh status"),
  ($h+"/kijito-qa-pass.sh"),($h+"/self-clear.sh")] | map("Bash("+.+")"))')
[ "$(allow)" = "$want" ] && grn "flag → the 10 exact rules appended after the existing one" || red "allow after flag: $(allow)"
jq -e '.permissions.allow | map(select(test("\\*"))) | length == 0' "$H/.claude/settings.json" >/dev/null \
  && grn "no added rule contains a wildcard" || red "a rule contains '*'"
jq -e '.permissions.deny == ["Bash(rm -rf /)"]' "$H/.claude/settings.json" >/dev/null && grn "permissions.deny untouched" || red "deny changed"
grep -q 'Undo: run the installer again with --disallow-self-clear' <<<"$out" && grep -q 'Bash(~/.claude/self-clear.sh)' <<<"$out" \
  && grn "the output lists the rules it added and names the undo" || red "output does not list rules + undo: $out"
[ "$(mode_of "$H/.claude/settings.json")" = 600 ] && grn "settings.json stays 0600" || red "mode $(mode_of "$H/.claude/settings.json")"

inst --allow-self-clear >/dev/null
[ "$(allow)" = "$want" ] && grn "running it twice adds no duplicates" || red "second run: $(allow)"

inst --disallow-self-clear >/dev/null
[ "$(allow)" = '["Bash(ls)"]' ] && grn "--disallow-self-clear removes exactly the added rules" || red "after disallow: $(allow)"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
