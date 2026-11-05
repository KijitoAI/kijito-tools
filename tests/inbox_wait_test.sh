#!/usr/bin/env bash
# Does kijito-inbox-wait.py wake on the events that matter, stay asleep through network blips, and
# refuse loudly when there is nothing to watch?
#
# WHY THIS EXISTS. The Monitor tool caps every watch at 30 minutes, so the inbox consumer the hook and
# skills recommend is now a ONE-SHOT waiter run with Bash run_in_background (no time limit; the session
# is woken once, when it exits). What must hold:
#   - no stream file -> a fast non-zero exit naming how to start the producer (tail -F on a missing
#     file waits forever, and that silence reads as "no mail");
#   - a `new` line -> exit 0, printing it; liveness ticks (heartbeat/armed) never wake;
#   - a source-DOWN alert followed by `recovered` inside the grace window -> no wake; one that does
#     not recover -> wakes with the alert once the window ends; any other alert wakes at once;
#   - --max-wait -> its own exit and line; a second waiter on the same stream -> refused;
#   - the existing consumer probes see the waiter (its child is a real `tail -n 0 -F <stream>`).
# The waiter runs byte-for-byte against temp streams; grace windows are seconds, so this takes seconds.
#
#   bash tests/inbox_wait_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAIT="$REPO/providers/claude/scripts/kijito-inbox-wait.py"
LIB="$REPO/providers/claude/scripts/kijito-persona-lib.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"
cleanup() { pkill -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT INT TERM
H="$T/home"; SH="$T/shim"; mkdir -p "$H" "$SH" "$T/proj"
# No supervisor on this synthetic machine, even on a Mac with a real launchd job or a Linux runner
# with systemd: the start hint must then be the one-command start.
printf '#!/usr/bin/env bash\nexit 1\n' > "$SH/launchctl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SH/systemctl"
chmod +x "$SH/launchctl" "$SH/systemctl"
# macOS scans a freshly written executable on its first run (seconds); pay that here, not inside a timing.
"$SH/launchctl" >/dev/null 2>&1; "$SH/systemctl" >/dev/null 2>&1
export XDG_CACHE_HOME="$T/xdg"

w() {  # run the waiter in the synthetic env (foreground); extra args pass through
  env HOME="$H" PATH="$SH:$PATH" CLAUDE_PROJECT_DIR="$T/proj" python3 -I "$WAIT" "$@"
}
OUT=""; PID=""
start_bg() {  # $1 = stream, rest = waiter args. Starts the waiter in the background, waits for its tail.
  local ev=$1; shift
  OUT="$T/out.$RANDOM"; : > "$OUT"
  ( cd "$T/proj" && w --events "$ev" "$@" > "$OUT" 2>&1; echo "rc=$?" >> "$OUT" ) &
  PID=$!
  local i=0
  while [ $i -lt 50 ]; do
    pgrep -f "^tail -n 0 -F $ev\$" >/dev/null 2>&1 && return 0
    sleep 0.1; i=$((i+1))
  done
  return 1
}
finished() { grep -q '^rc=' "$OUT"; }
wait_done() {  # $1 = seconds to allow
  local i=0 n=$(( ${1:-5} * 10 ))
  while [ $i -lt $n ]; do finished && return 0; sleep 0.1; i=$((i+1)); done
  return 1
}
rc_of() { sed -n 's/^rc=//p' "$OUT"; }
stop_bg() { pkill -f -- "--events $1" 2>/dev/null; wait "$PID" 2>/dev/null; }
mkev() { local f="$T/$1"; : > "$f"; printf '%s' "$f"; }

NEW='{"event": "new", "source": "kijito", "ts": "2026-11-05T00:00:00Z", "id": 4242, "from": "ann", "persona": "tester", "wake_class": "mail"}'
DOWN='{"event": "alert", "source": "kijito", "reason": "unreachable", "consecutive_failures": 3, "seconds": 95, "floor_seconds": 90, "wake_class": "diagnostic"}'
UP='{"event": "recovered", "source": "kijito", "cursor": 4241, "wake_class": "diagnostic"}'
HB='{"event": "heartbeat", "source": "kijito", "cursor": 4241, "wake_class": "liveness"}'
STRANDED='{"event": "alert", "source": "kijito", "reason": "stranded-mail: 1 inbox(es) receiving mail nobody watches", "stranded_inboxes": ["x"], "wake_class": "diagnostic"}'

echo "kijito-inbox-wait checks:"

# 1. missing stream -> fast, non-zero, says how to start the producer
s=$(date +%s); out=$(w --persona tester --events "$T/no-such.ndjson"); rc=$?; e=$(( $(date +%s) - s ))
# "fast" = it returns at all: the failure this guards is waiting forever. The bound is loose for slow CI.
if [ "$rc" = 2 ] && [ "$e" -le 8 ] && grep -q "NO STREAM" <<<"$out" && grep -q "kijito-inbox-start.sh --persona tester" <<<"$out"; then
  grn "missing stream file -> exit 2 in ${e}s, naming kijito-inbox-start.sh"
else red "missing stream gave rc=$rc after ${e}s: $out"; fi

# 2. a persona with no stream anywhere on this machine -> the same refusal, by persona
out=$(w --persona ghost); rc=$?
[ "$rc" = 2 ] && grep -q "NO STREAM" <<<"$out" && grep -q "'ghost'" <<<"$out" \
  && grn "persona with no stream -> exit 2 naming the persona" || red "persona with no stream gave rc=$rc: $out"

# 3. no persona at all -> exit 2, says what to pass
out=$(cd "$T/proj" && w); rc=$?
[ "$rc" = 2 ] && grep -q "NO PERSONA" <<<"$out" && grn "no persona -> exit 2 NO PERSONA" || red "no persona gave rc=$rc: $out"

# 4. the persona resolves through the shared lib (producer's --safe-persona rule + the layouts)
mkdir -p "$H/.kijito-monitor"; : > "$H/.kijito-monitor/tester.jsonl"
printf '#!/usr/bin/env bash\n[ "$1" = --safe-persona ] && printf %%s "$2"\n' > "$SH/kijito-inbox-monitor"; chmod +x "$SH/kijito-inbox-monitor"
echo tester > "$T/proj/.kijito_persona"
OUT="$T/out.marker"; ( cd "$T/proj" && w --max-wait 1 > "$OUT" 2>&1; echo "rc=$?" >> "$OUT" )
grep -q "TIMEOUT - no wake-worthy event on $H/.kijito-monitor/tester.jsonl" "$OUT" \
  && grn "persona from the .kijito_persona marker resolves to its stream via the shared lib" \
  || red "marker/persona resolution failed: $(cat "$OUT")"
rm -f "$T/proj/.kijito_persona"

# 5. bad arguments -> 1, never the NO STREAM code
out=$(w --grace -1 2>&1); rc=$?
[ "$rc" = 1 ] && grn "bad arguments -> exit 1 (not 2)" || red "bad arguments gave rc=$rc: $out"

# 6. a `new` line -> exit 0 and prints it; liveness ticks before it do not wake
EV=$(mkev a.ndjson)
if start_bg "$EV"; then
  echo "$HB" >> "$EV"; echo '{"event": "armed", "cursor": 1}' >> "$EV"; sleep 0.5
  finished && red "a heartbeat/armed line woke the waiter: $(cat "$OUT")" || grn "heartbeat and armed lines do not wake"
  echo "$NEW" >> "$EV"
  if wait_done 5 && [ "$(rc_of)" = 0 ] && grep -q '"id": 4242' "$OUT"; then
    grn "a new line -> exit 0, printing the event"
  else red "new line did not wake with exit 0: $(cat "$OUT")"; fi
  sleep 0.2
  pgrep -f "^tail -n 0 -F $EV\$" >/dev/null && red "the tail outlived the waiter" || grn "the tail child exits with the waiter"
else red "the waiter's tail never attached"; fi

# 7. the existing consumer probes see a waiting waiter as the stream's consumer
EV=$(mkev b.ndjson)
if start_bg "$EV" --max-wait 30; then
  if bash -c '. "$1"; kijito_stream_consumed "$2"' _ "$LIB" "$EV"; then
    grn "kijito_stream_consumed sees the waiter (its child is a real tail -n 0 -F <stream>)"
  else red "the shared consumer probe does not see the waiter"; fi
  # ...and kijito_stream_waiter ties the live waiter to THIS stream (so the hook never calls its old tail
  # an orphan), while a stream nobody waits on is answered "none"
  if bash -c '. "$1"; kijito_stream_waiter "$2"' _ "$LIB" "$EV" && ! bash -c '. "$1"; kijito_stream_waiter "$2"' _ "$LIB" "$T/other.ndjson"; then
    grn "kijito_stream_waiter finds the waiter on its own stream and not on another"
  else red "kijito_stream_waiter did not tie the waiter to its stream"; fi
  # 8. a second waiter on the same stream is refused: the inbox is already watched
  out=$(w --events "$EV" --max-wait 5); rc=$?
  [ "$rc" = 4 ] && grep -q "ALREADY WAITING" <<<"$out" \
    && grn "a second waiter on the same stream -> exit 4 ALREADY WAITING" || red "second waiter gave rc=$rc: $out"
  stop_bg "$EV"
else red "the waiter's tail never attached (probe check)"; fi

# 9. DOWN alert then recovered inside the grace window -> still waiting; then a new line wakes it
EV=$(mkev c.ndjson)
if start_bg "$EV" --grace 2; then
  echo "$DOWN" >> "$EV"; sleep 0.3; echo "$UP" >> "$EV"
  sleep 3     # past the grace window: a held alert would have fired by now
  if finished; then red "alert+recovered inside the grace window woke the waiter: $(cat "$OUT")"
  else grn "a source-DOWN alert that recovers inside the grace window wakes nobody"; fi
  echo "$NEW" >> "$EV"
  if wait_done 5 && [ "$(rc_of)" = 0 ] && grep -q '"event": "new"' "$OUT" && ! grep -q '"alert"' "$OUT"; then
    grn "after the blip, the next new line wakes it (and the blip is not reported)"
  else red "after the blip the new line did not wake cleanly: $(cat "$OUT")"; fi
else red "the waiter's tail never attached (blip check)"; fi

# 10. DOWN alert with no recovery -> wakes once the window ends, printing the alert
EV=$(mkev d.ndjson)
if start_bg "$EV" --grace 1; then
  s=$(date +%s); echo "$DOWN" >> "$EV"
  if wait_done 5 && [ "$(rc_of)" = 0 ] && grep -q '"consecutive_failures": 3' "$OUT" && grep -q "no 'recovered'" "$OUT"; then
    grn "an unrecovered source-DOWN alert wakes after the grace window, printing the alert"
  else red "unrecovered alert did not wake: $(cat "$OUT")"; fi
else red "the waiter's tail never attached (outage check)"; fi

# 11. any OTHER alert is not network noise: it wakes at once even with a long grace window
EV=$(mkev e.ndjson)
if start_bg "$EV" --grace 600; then
  echo "$STRANDED" >> "$EV"
  if wait_done 3 && [ "$(rc_of)" = 0 ] && grep -q "stranded-mail" "$OUT"; then
    grn "a non-network alert wakes immediately (only source-DOWN is debounced)"
  else red "a stranded-mail alert was held: $(cat "$OUT")"; stop_bg "$EV"; fi
else red "the waiter's tail never attached (other-alert check)"; fi

# 12. a bare recovered (its alert already woke an earlier waiter) does not wake
EV=$(mkev f.ndjson)
if start_bg "$EV" --max-wait 2; then
  echo "$UP" >> "$EV"
  if wait_done 5 && [ "$(rc_of)" = 3 ]; then grn "a bare recovered does not wake (the wait ran to --max-wait)"
  else red "a bare recovered woke the waiter: $(cat "$OUT")"; fi
else red "the waiter's tail never attached (bare-recovered check)"; fi

# 13. --grace 0 restores the old behaviour: the alert wakes at once
EV=$(mkev g.ndjson)
if start_bg "$EV" --grace 0; then
  echo "$DOWN" >> "$EV"
  if wait_done 3 && [ "$(rc_of)" = 0 ] && grep -q '"consecutive_failures"' "$OUT"; then
    grn "--grace 0 -> a source-DOWN alert wakes immediately"
  else red "--grace 0 did not wake on the alert: $(cat "$OUT")"; stop_bg "$EV"; fi
else red "the waiter's tail never attached (grace 0 check)"; fi

# 14. --max-wait -> exit 3 with its own line
EV=$(mkev h.ndjson)
s=$(date +%s); out=$(w --events "$EV" --max-wait 1); rc=$?; e=$(( $(date +%s) - s ))
[ "$rc" = 3 ] && grep -q "TIMEOUT" <<<"$out" && [ "$e" -le 4 ] \
  && grn "--max-wait 1 -> exit 3 with a TIMEOUT line after ${e}s" || red "--max-wait gave rc=$rc after ${e}s: $out"

# 15. a long event line is truncated, so a wake does not dump a whole message body
EV=$(mkev i.ndjson)
if start_bg "$EV"; then
  printf '{"event": "new", "id": 7, "content": "%s"}\n' "$(printf 'x%.0s' $(seq 1 2000))" >> "$EV"
  if wait_done 5 && [ "$(rc_of)" = 0 ] && grep -q '\.\.\.\[+[0-9]* chars\]' "$OUT" \
     && [ "$(head -1 "$OUT" | wc -c)" -lt 500 ]; then
    grn "a long event line is truncated to ~400 chars with the remainder counted"
  else red "long line not truncated: $(head -c 200 "$OUT")"; fi
else red "the waiter's tail never attached (truncation check)"; fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
