#!/usr/bin/env bash
# Does kijito-inbox-start.sh take a stranger from "installed" to "proven", and refuse honestly when it can't?
#
# WHY THIS EXISTS (row M383). The first stranger cold run (river 10901) installed the monitor and stopped:
# nothing started it, the self-test said "COULD NOT MEASURE: no persona", and no message was sent. The
# helper is the missing last step. What must hold:
#   - no persona / no monitor / no token -> exit 2 with the exact fix, and never a secret on screen;
#   - otherwise it STARTS a producer for the persona and waits for its `armed` row;
#   - a second run does not start a second producer;
#   - it never exits 0 before the wake is proven (3 = stream proven, consumer left; 1 = a hop failed).
# The monitor and the self-test are shimmed (no network); the helper runs byte-for-byte.
#
#   bash tests/inbox_start_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START="$REPO/providers/claude/scripts/kijito-inbox-start.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"
cleanup() { pkill -f "$T/bin/kijito-inbox-monitor" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT INT TERM
BIN="$T/bin"; mkdir -p "$BIN" "$T/proj"
# Fake monitor: --safe-persona names the file; a run appends an `armed` row to --events-file and stays up.
cat > "$BIN/kijito-inbox-monitor" <<'SHIM'
#!/usr/bin/env bash
[ "${1:-}" = --safe-persona ] && { printf '%s' "$2"; exit 0; }
ev=""; p=""
while [ $# -gt 0 ]; do case "$1" in --events-file) ev=$2; shift 2 ;; --persona) p=$2; shift 2 ;; *) shift ;; esac; done
echo "fake monitor starting for $p" >&2
printf '{"event": "armed", "persona": "%s", "cursor": 1}\n' "$p" >> "$ev"
sleep 300 & wait
SHIM
# Fake self-test: FAKE_ST picks the verdict the real one would print.
cat > "$BIN/selftest" <<'SHIM'
#!/usr/bin/env bash
echo "kijito inbox self-test [persona=$2]"
case "${FAKE_ST:-consumer}" in
  all)      echo "  ok    stream: the message reached x after ~1s"; echo "  ok    consumer: armed"; exit 0 ;;
  consumer) echo "  ok    stream: the message reached x after ~1s"; echo "  FAIL  consumer: nothing reads x"; exit 1 ;;
  stream)   echo "  FAIL  stream: nothing new arrived in x within 20s"; exit 1 ;;
  cantsend) echo "  ????  stream: COULD NOT MEASURE - the key refused to SEND the test message (HTTP 403)"; exit 2 ;;
esac
SHIM
chmod +x "$BIN/kijito-inbox-monitor" "$BIN/selftest"
H="$T/home"; mkdir -p "$H"
run() {  # env overrides as args, then runs the helper from the project dir; prints output + "rc=N"
  ( cd "$T/proj" && env -u KIJITOMON_TOKEN_FILE -u CLAUDE_PROJECT_DIR HOME="$H" PATH="$BIN:/usr/bin:/bin" \
      KIJITO_SELFTEST="$BIN/selftest" "$@" bash "$START" ${ARGS:-} 2>&1; echo "rc=$?" )
}

echo "kijito-inbox-start checks:"
out=$(run); rc=${out##*rc=}
[ "$rc" = 2 ] && grep -q 'COULD NOT RUN: no persona' <<<"$out" && grep -q 'kijito-inbox-start.sh --persona <name>' <<<"$out" \
  && grn "no persona: exit 2 with the exact command" || red "no persona: rc=$rc $out"

out=$(ARGS="--persona tester" run PATH="/usr/bin:/bin"); rc=${out##*rc=}
[ "$rc" = 2 ] && grep -q 'uv tool install kijito-inbox-monitor' <<<"$out" \
  && grn "no monitor installed: exit 2 with the install line" || red "no monitor: rc=$rc $out"

out=$(ARGS="--persona tester" run); rc=${out##*rc=}
# The mint must carry memory.write: the self-test SENDS one message, a hive write (river 10985 / Kijito M339).
[ "$rc" = 2 ] && grep -q 'kijito_api_key(action="create"' <<<"$out" \
  && grep -q 'scopes=\["memory.read","memory.write"\]' <<<"$out" && grep -q 'chmod 600' <<<"$out" \
  && grn "no token: exit 2 with a mint recipe the self-test can actually use (read + write)" || red "no token: rc=$rc $out"

mkdir -p "$H/.config/kijito-inbox-monitor"; printf 'kjt_SECRET_DO_NOT_PRINT' > "$H/.config/kijito-inbox-monitor/token"
chmod 600 "$H/.config/kijito-inbox-monitor/token"
echo tester > "$T/proj/.kijito_persona"      # the marker route this time, not --persona
out=$(run); rc=${out##*rc=}
EV="$H/.local/state/kijito-inbox-monitor/events.tester.ndjson"
if [ "$rc" = 3 ] && grep -q 'producer armed for tester' <<<"$out" && [ -s "$EV" ]; then
  grn "marker persona + token: a producer is STARTED and armed (stream $EV)"
else red "start: rc=$rc $out"; fi
grep -q "tail -n 0 -F $EV" <<<"$out" && grep -q 'Not done until' <<<"$out" \
  && grn "stream proven, consumer left: exit 3 (never 0) and the exact consumer line" || red "consumer step text: $out"
grep -q 'kjt_SECRET' <<<"$out" && red "a token VALUE was printed" || grn "the token value is never printed"
n=$(pgrep -fc "$BIN/kijito-inbox-monitor .*--persona tester" 2>/dev/null || echo 0)
[ "$n" = 1 ] && grn "exactly one producer is running for the persona" || red "producers for tester: $n"

out=$(run); rc=${out##*rc=}
n=$(pgrep -fc "$BIN/kijito-inbox-monitor .*--persona tester" 2>/dev/null || echo 0)
grep -q 'already covers tester' <<<"$out" && [ "$n" = 1 ] \
  && grn "a second run leaves the running producer alone (still one)" || red "second run: n=$n $out"

# A stream written seconds ago is NOT a producer: the old check trusted a 10-minute mtime window, so a
# producer that had just died blocked its own restart for 10 minutes (river 10985, M312 cold rerun).
pkill -f "$BIN/kijito-inbox-monitor .*--persona tester" 2>/dev/null; sleep 0.5
touch "$EV"
out=$(run); rc=${out##*rc=}
n=$(pgrep -fc "$BIN/kijito-inbox-monitor .*--persona tester" 2>/dev/null || echo 0)
if ! grep -q 'already covers tester' <<<"$out" && grep -q 'producer armed for tester' <<<"$out" && [ "$n" = 1 ]; then
  grn "a fresh stream with NO producer process is restarted at once (mtime is not a producer)"
else red "dead producer + fresh stream: n=$n $out"; fi

out=$(run FAKE_ST=all); rc=${out##*rc=}
[ "$rc" = 0 ] && grep -q '✓ PROVEN' <<<"$out" && grn "a proven wake is the ONLY exit 0" || red "all-green: rc=$rc $out"
out=$(run FAKE_ST=stream); rc=${out##*rc=}
[ "$rc" = 1 ] && grep -q 'did NOT reach your stream' <<<"$out" && ! grep -q 'Not done until' <<<"$out" \
  && grn "a message that never reached the stream is a FAILURE (1), not 'consumer left'" || red "stream fail: rc=$rc $out"
# A self-test that could not RUN its test (a read-only key cannot send) is "something missing" (2), never
# "the monitor is not working" (1) - that false verdict hit a working monitor in river's M312 rerun (10985).
out=$(run FAKE_ST=cantsend); rc=${out##*rc=}
[ "$rc" = 2 ] && grep -q 'NOT PROVEN YET' <<<"$out" && ! grep -q 'did NOT reach your stream' <<<"$out" \
  && grn "a test that could not be sent is exit 2 (what is missing), not 'not working'" || red "cantsend: rc=$rc $out"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
