#!/usr/bin/env bash
# Nothing we SHIP may carry an operator-private endpoint.
#
# WHY THIS EXISTS (river 10985, from the 2026-09-30 M312 cold reruns). kijito-start/SKILL.md shipped
# river's PROD-PAGER ntfy topic URL, and a `while true; curl` Monitor for it, to every user: anyone who
# installed kijito-tools could read the fleet's pages or publish fake ones. It also scared a stranger
# agent off the catch-up entirely. An ntfy topic is a bearer capability — its name IS the secret — so
# the rule is: no concrete ntfy topic URL anywhere in the shipped payload. Generic mentions of ntfy
# ("ntfy remains optional") are fine; a URL that names a topic is not.
#
#   bash tests/no_operator_endpoints_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

# A concrete topic: ntfy.sh/<name>, with or without a scheme. Topic names are [-_A-Za-z0-9].
PAT='ntfy\.sh/[-_A-Za-z0-9]{3,}'
# What the packages ship (npm files[] / wheel include): the installer, bin, src and every provider.
SHIPPED=(install.sh bin src providers)

scan() {  # $1 = root; prints offending file:line matches
  (cd "$1" && grep -rnEI "$PAT" "${SHIPPED[@]}" 2>/dev/null)
}

echo "shipped payload carries no operator-private endpoint:"
hits=$(scan "$REPO")
if [ -z "$hits" ]; then grn "no concrete ntfy topic URL in: ${SHIPPED[*]}"
else red "operator endpoint shipped:"; printf '        %s\n' "$hits"; fi

# Positive control: the scanner must catch the exact line that shipped before this fix.
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/providers/claude/skills/kijito-start"
printf '%s\n' '     `Monitor(command="while true; do curl -N -s --max-time 86400 https://ntfy.sh/kijito-prod-000000000000/json 2>/dev/null")`' \
  > "$T/providers/claude/skills/kijito-start/SKILL.md"
if [ -n "$(scan "$T")" ]; then grn "control: the scanner catches the pre-fix skill line"
else red "control: the scanner MISSED a planted ntfy topic URL - it cannot be trusted"; fi
printf '%s\n' 'Opt-in config only; ntfy remains entirely optional.' > "$T/providers/claude/skills/kijito-start/SKILL.md"
if [ -z "$(scan "$T")" ]; then grn "control: a generic mention of ntfy is allowed"
else red "control: a generic ntfy mention was flagged"; fi

echo; echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
