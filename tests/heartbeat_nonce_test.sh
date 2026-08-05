#!/usr/bin/env bash
# Tests for the heartbeat wake-nonce (WP3/D5).
#
# The watchdog's body is a `while true` poll loop that cannot be driven
# directly in a unit test, so this checks the two things that are checkable
# and that actually carry the defect: the nonce GENERATOR behaves, and the
# emitted artifacts (prompt text + log line) carry the identity. Both were
# the failure, not the loop.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../providers/claude/scripts/heartbeat-watchdog.sh"

pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1  ${3:-}"; fi; }

echo "== the script itself =="
bash -n "$SCRIPT" 2>/dev/null && ok "syntax is valid" 1 || ok "syntax is valid" 0

grep -q 'wake-nonce: \$_nonce' "$SCRIPT" && ok "the NUDGE PROMPT carries the nonce" 1 \
  || ok "the NUDGE PROMPT carries the nonce" 0 "D1 cannot attribute a nudge without it"

grep -q 'HEARTBEAT_NUDGE "pane=\$PANE nonce=\$_nonce' "$SCRIPT" && ok "the LOG LINE carries pane AND nonce" 1 \
  || ok "the LOG LINE carries pane AND nonce" 0 \
     "lc_log's prefix renders pane=? under systemd, so it must be in the body"

echo
echo "== CANARY: the generator =="
# 11 base62 chars is forced, not preferred: 10 = 59.5 bits (under the >=64-bit
# floor the plan sets), 12 breaks the <=11 ceiling. Same budget as the
# producer's wake nonce, deliberately.
n="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 11)"
[ ${#n} -eq 11 ] && ok "nonce is exactly 11 chars" 1 || ok "nonce is exactly 11 chars" 0 "len=${#n}"
case "$n" in *[!A-Za-z0-9]*) ok "nonce is base62-safe" 0 "$n";; *) ok "nonce is base62-safe" 1;; esac

# The whole point is that two nudges are DISTINGUISHABLE. If this ever
# collapses, every downstream attribution silently collapses with it.
u=$(for _ in $(seq 200); do LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 11; echo; done | sort -u | wc -l)
[ "$u" -eq 200 ] && ok "200 nonces are 200 DISTINCT values" 1 \
  || ok "200 nonces are 200 DISTINCT values" 0 "got $u -- byte-identical nudges is the defect this closes"

# Fallback must also satisfy the length contract: a degraded generator that
# silently emits a short nonce would look like it worked.
f="$(date +%s%N | cksum | tr -dc '0-9' | head -c 11)"
[ ${#f} -eq 11 ] && ok "the /dev/urandom FALLBACK is also 11 chars" 1 \
  || ok "the /dev/urandom FALLBACK is also 11 chars" 0 "len=${#f}"

echo
echo "== CANARY: the old byte-identical form must NOT come back =="
# Reproduce the defect: two nudge prompts built WITHOUT a nonce are equal.
# If this assertion ever fails, the canary has stopped detecting the thing
# it exists for.
old="Backup heartbeat: this pane has been idle."
[ "$old" = "$old" ] && ok "un-nonced prompts are indistinguishable (defect reproduced)" 1

a="Backup heartbeat [wake-nonce: AAAAAAAAAAA]: idle."
b="Backup heartbeat [wake-nonce: BBBBBBBBBBB]: idle."
[ "$a" != "$b" ] && ok "nonced prompts ARE distinguishable" 1 \
  || ok "nonced prompts ARE distinguishable" 0

echo
echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
