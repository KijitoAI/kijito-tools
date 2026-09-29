#!/usr/bin/env bash
# Start the Kijito inbox monitor for ONE persona and prove, with a real message, that mail reaches it.
#
#   ~/.claude/kijito-inbox-start.sh --persona <name> [--token-file <file>]
#
# WHY THIS EXISTS (row M383). The first stranger cold run (river 10901, 2026-09-29) installed the monitor
# and stopped: nothing ever STARTED it, the installer's self-test said "COULD NOT MEASURE: no persona", and
# no message was ever sent. Installed is not the same as working, and the gap fails as silence. This script
# is the missing last step: persona -> token -> a running producer -> a self-sent message that lands in the
# event stream -> the one consumer line your agent must arm so the message WAKES it.
#
# It starts nothing silently: you run it, it says what it started and where, and a producer started here
# does NOT survive a reboot or logout (see the monitor README, "Running the producer for real").
# Exit: 0 = the WAKE is proven end to end · 3 = the stream is proven and only your agent's consumer is left
# (NOT done - the text says what to arm) · 1 = a hop failed · 2 = could not run (no persona, no monitor, no
# token), with the exact fix printed. Never 0 before the wake is proven: an agent reads 0 as "done".
set -u
PERSONA=""; TOKEN_FILE="${KIJITOMON_TOKEN_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --persona) PERSONA=${2:-}; shift 2 ;;
    --persona=*) PERSONA=${1#*=}; shift ;;
    --token-file) TOKEN_FILE=${2:-}; shift 2 ;;
    --token-file=*) TOKEN_FILE=${1#*=}; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done
_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_lib="$_dir/kijito-persona-lib.sh"; [ -r "$_lib" ] || _lib="$HOME/.claude/kijito-persona-lib.sh"
# shellcheck source=/dev/null
. "$_lib" || { echo "COULD NOT RUN: cannot source kijito-persona-lib.sh"; exit 2; }
SELFTEST="${KIJITO_SELFTEST:-$_dir/inbox-selftest.sh}"; [ -x "$SELFTEST" ] || SELFTEST="$HOME/.claude/inbox-selftest.sh"

# ── 1. persona ─────────────────────────────────────────────────────────────────────────────────────
[ -n "$PERSONA" ] || PERSONA=$(kijito_persona_from_marker 2>/dev/null || true)
if [ -z "$PERSONA" ]; then
  cat <<'EOF'
COULD NOT RUN: no persona. The monitor watches ONE persona's inbox - the name your agent passes as
persona= on every Kijito write (for a first project, the project's name works well).
  Fix: ~/.claude/kijito-inbox-start.sh --persona <name>
       (or write that name on one line into a .kijito_persona file in your project root)
EOF
  exit 2
fi

# ── 2. the monitor itself ──────────────────────────────────────────────────────────────────────────
KM=""
for c in "${KIJITOMON_BIN:-}" "$(command -v kijito-inbox-monitor 2>/dev/null)" "$HOME/.local/bin/kijito-inbox-monitor"; do
  if [ -n "$c" ] && [ -x "$c" ]; then KM=$c; break; fi
done
if [ -z "$KM" ]; then
  cat <<'EOF'
COULD NOT RUN: kijito-inbox-monitor is not installed.
  Fix: uv tool install kijito-inbox-monitor      (or: pipx install kijito-inbox-monitor)
       then run this again.
EOF
  exit 2
fi

# ── 3. a token the monitor can use ─────────────────────────────────────────────────────────────────
# The monitor polls the REST API, so it needs an API key even when your agent signed in through OAuth.
if [ -z "$TOKEN_FILE" ]; then
  for tf in "$HOME/.claude/.kijito_api_token.$PERSONA" "$HOME/.claude/.kijito_api_token" \
            "$HOME/.config/kijito-inbox-monitor/token"; do
    [ -s "$tf" ] && { TOKEN_FILE=$tf; break; }
  done
fi
if [ -z "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
  cat <<EOF
COULD NOT RUN: no Kijito API key for the monitor. If your agent signed in through OAuth (/mcp), there is
no key on disk yet - the agent can mint one from its own session, with your OK:
  1. kijito_api_key(action="create", name="inbox monitor on $(hostname 2>/dev/null || echo this-host)",
                    scopes=["memory.read"], persona="$PERSONA")
     (it creates a durable, revocable read-only key; the secret is shown ONCE)
  2. save it to ~/.config/kijito-inbox-monitor/token and chmod 600 it - never into a memory or a message
  3. run this again
EOF
  exit 2
fi

echo "kijito inbox start [persona=$PERSONA]"
# ── 4. a producer for this persona ─────────────────────────────────────────────────────────────────
EVENTS=$(kijito_stream_for_persona "$PERSONA" 2>/dev/null || true)
# Is a producer ALREADY covering THIS persona? "Some producer runs on this host" is not the question (on a
# multi-persona seat it answers for somebody else). Either a process was started for this persona, or its
# stream was written in the last 10 minutes (a producer that watches several personas carries no --persona
# for each, but it heartbeats).
_covered() {
  if command -v pgrep >/dev/null 2>&1 \
     && pgrep -f "kijito[-_]inbox[-_]monitor(\.py)? .*--persona[ =]$PERSONA( |\$)" >/dev/null 2>&1; then return 0; fi
  [ -n "$EVENTS" ] && [ -n "$(find "$EVENTS" -mmin -10 2>/dev/null)" ]
}
if _covered; then
  echo "  ok    a producer already covers $PERSONA${EVENTS:+ (stream: $EVENTS)} - leaving it alone"
else
  SAFE=$("$KM" --safe-persona "$PERSONA" 2>/dev/null)
  [ -n "$SAFE" ] || { echo "  FAIL  the monitor could not name a stream file for '$PERSONA' (is it older than 0.5.4? upgrade it)"; exit 1; }
  D="$HOME/.local/state/kijito-inbox-monitor"; mkdir -p "$D"; chmod 700 "$D" 2>/dev/null
  # Reuse a stream this persona already has (the self-test looks there first); otherwise the monitor's own
  # XDG-state layout, which the self-test and the SessionStart hook also know.
  [ -n "$EVENTS" ] || EVENTS="$D/events.$SAFE.ndjson"
  LOG="$D/producer.$SAFE.log"
  n0=0; [ -f "$EVENTS" ] && n0=$(wc -l < "$EVENTS")
  nohup "$KM" --persona "$PERSONA" --token-file "$TOKEN_FILE" \
        --events-file "$EVENTS" --state-file "$D/hive.$SAFE.json" --heartbeat 120 >> "$LOG" 2>&1 &
  pid=$!
  echo "  ..    started the producer (pid $pid) -> $EVENTS   (log: $LOG)"
  armed=0
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    if [ -f "$EVENTS" ] && tail -n +"$((n0+1))" "$EVENTS" | grep -Eq '"event": ?"armed"'; then armed=1; break; fi
    sleep 1
  done
  if [ "$armed" != 1 ]; then
    echo "  FAIL  the producer did not arm within 60 s. Last log lines:"; tail -n 5 "$LOG" 2>/dev/null | sed 's/^/          /'
    exit 1
  fi
  echo "  ok    producer armed for $PERSONA"
  echo "        (it runs until you log out or reboot; to keep it running, see the monitor README:"
  echo "         \"Running the producer for real (supervision)\")"
fi

# ── 5. prove it with a real message, then name the one step left ───────────────────────────────────
echo
out=$(KIJITOMON_TOKEN_FILE="$TOKEN_FILE" "$SELFTEST" --persona "$PERSONA" 2>&1); st=$?
printf '%s\n' "$out"
echo
if [ "$st" = 0 ]; then
  echo "✓ PROVEN: a real message reached your stream and woke a consumer."
  exit 0
fi
# Only a CONSUMER-only failure is the expected state here; a message that never reached the stream is not.
if ! printf '%s\n' "$out" | grep -q '^  ok    stream:'; then
  echo "✗ The test message did NOT reach your stream (see above). The monitor is not working yet."
  exit 1
fi
cat <<EOF
The monitor is running and your stream is receiving mail. The WAKE is not proven until your agent reads
the stream. In Claude Code, have your agent arm this ONCE per session (Monitor tool, persistent):
  tail -n 0 -F $EVENTS | grep --line-buffered -E '"event": ?"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added|still_unread)"'
then send itself one message (kijito_hive_send to "$PERSONA") and confirm it was woken - or re-run:
  $SELFTEST --persona $PERSONA
Not done until that says the wake is PROVEN.
EOF
exit 3
