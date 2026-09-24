#!/usr/bin/env bash
# Row M291 — armed sessions went permanently deaf after a Claude usage-limit outage.
#
# Drives the REAL heartbeat-watchdog.sh and claude-armed.sh against a REAL tmux server (a private
# socket under a temp dir, so no live pane on the host can be touched), with a fake "agent" in the
# pane that behaves like an armed session: it reads what is typed into it, and on a heartbeat nudge
# re-arms a `tail -n 0 -F` consumer on its event stream — unless it is still usage-limited.
#
#   A. CANARY: a session whose consumer died mid-loop (the limit hit) is flagged UNCONSUMED-STREAM,
#      stays deaf while the limit holds, and is RE-ARMED by the watchdog's nudge once it clears.
#   B. the nudge never types into the folder-trust dialog (Enter there = "No, exit").
#   C. claude-armed.sh starts the watchdog itself, stops only the one it started, and honours opt-out.
#   U. the menu matcher on fixtures, including the screens it must NOT refuse.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$HERE/../providers/claude/scripts"
WD="$SCRIPTS/heartbeat-watchdog.sh"
ARMED="$SCRIPTS/claude-armed.sh"

pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1  ${3:-}"; fi; }

command -v tmux >/dev/null 2>&1 || { echo "SKIP: no tmux (this test needs a real tmux server)"; exit 0; }

T=$(mktemp -d); P="m291canary$$"
export TMUX_TMPDIR="$T/sock"; mkdir -p "$TMUX_TMPDIR"; unset TMUX TMUX_PANE
LC="$T/lc"; mkdir -p "$LC" "$T/home/.kijito-monitor" "$T/proj" "$T/state" "$T/bin"
STREAM="$T/home/.kijito-monitor/$P.jsonl"
printf '{"event": "armed", "persona": "%s"}\n' "$P" > "$STREAM"
printf '%s\n' "$P" > "$T/proj/.kijito_persona"
WDPIDS=()
# Watchdogs that belong to the HOST (e.g. a kijito-heartbeat@N unit for a real pane %N) must neither be
# counted nor touched: a private tmux server's pane ids start at %0 too, so they can collide by name.
PREEXISTING=" $(pgrep -f 'heartbeat-watchdog\.sh' | tr '\n' ' ') "
cleanup() {
  for p in "${WDPIDS[@]+"${WDPIDS[@]}"}"; do kill "$p" 2>/dev/null; done
  pkill -f "tail -n 0 -F $STREAM" 2>/dev/null
  tmux kill-server 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

# the fake armed session
cat > "$T/agent.sh" <<'AGENT'
#!/usr/bin/env bash
stream=$1; state=$2; mode=${3:-chat}
if [ "$mode" = trust ]; then
  printf ' Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit\n'
else
  echo "fake agent ready"
fi
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$state/received.$mode"
  if [ -f "$state/LIMIT" ]; then echo "usage limit reached - resets later"; continue; fi
  case "$line" in
    *"Backup heartbeat"*) tail -n 0 -F "$stream" >/dev/null 2>&1 & echo $! > "$state/consumer.pid"; echo "consumer re-armed" ;;
  esac
done
AGENT

consumed() { pgrep -f "tail -n 0 -F.*$P\.jsonl" | while read -r p; do [ "$(ps -o comm= -p "$p")" = tail ] && echo "$p"; done | grep -c .; }
wait_for() { local i=0; while [ $i -lt "$2" ]; do eval "$1" && return 0; sleep 1; i=$((i+1)); done; return 1; }
run_wd() {   # $1 = pane
  HOME="$T/home" KIJITO_LC_DIR="$LC" KIJITO_AUTOCATCHUP=1 HEARTBEAT_POLL=1 HEARTBEAT_QUIET=2 \
    HEARTBEAT_UNCONSUMED_SECS=2 KIJITO_SEND_SETTLE=0.3 bash "$WD" "$1" >/dev/null 2>&1 &
  WDPIDS+=("$!")
}

# Push this server's pane ids PAST every pane id a host watchdog names, so a name collision (see
# lc_heartbeat_running's KNOWN LIMIT) cannot decide a result here.
hostmax=$(pgrep -af 'heartbeat-watchdog\.sh %' | sed -n 's/.*heartbeat-watchdog\.sh %\([0-9]*\)$/\1/p' | sort -n | tail -1)
tmux new-session -d -s burn "sleep 600"
i=0; while [ "$i" -le "${hostmax:-0}" ]; do tmux new-window -d -t burn "sleep 600"; i=$((i+1)); done

echo "== A. CANARY: a session killed mid-loop by a usage limit is re-armed after the limit clears =="
tmux new-session -d -s a -x 200 -y 50 -c "$T/proj" "bash '$T/agent.sh' '$STREAM' '$T/state' chat"
PA=$(tmux list-panes -t a -F '#{pane_id}')
tail -n 0 -F "$STREAM" >/dev/null 2>&1 & C0=$!           # the armed loop's consumer
sleep 0.5
[ "$(consumed)" = 1 ] && ok "positive control: the pre-limit consumer is visible to the check" 1 || ok "positive control: consumer visible" 0 "got $(consumed)"
touch "$T/state/LIMIT"; kill "$C0"; wait "$C0" 2>/dev/null   # the limit hits: the loop, and its consumer, end
run_wd "$PA"
sleep 2
printf '{"event": "new", "id": 1, "persona": "%s"}\n' "$P" >> "$STREAM"   # mail arrives; nobody reads it
wait_for '[ -f "$LC/unconsumed.$PA" ]' 20 && ok "UNCONSUMED-STREAM flag raised for the pane" 1 || ok "UNCONSUMED-STREAM flag raised" 0
grep -q "HEARTBEAT_UNCONSUMED_STREAM target_pane=$PA persona=$P" "$LC/lifecycle.log" 2>/dev/null \
  && ok "the alert is its own log line, naming pane + persona" 1 || ok "alert log line" 0 "$(grep HEARTBEAT "$LC/lifecycle.log" | tail -3)"
grep -q "dormant" "$LC/lifecycle.log" 2>/dev/null && ok "the alert is DISTINCT from 'dormant inbox'" 0 || ok "the alert is DISTINCT from 'dormant inbox'" 1
wait_for 'grep -q "INBOX IS DEAF" "$T/state/received.chat" 2>/dev/null' 20 \
  && ok "the nudge tells the deaf session to re-arm its consumer FIRST" 1 || ok "deaf nudge delivered" 0
[ "$(consumed)" = 0 ] && ok "while the limit holds, nothing re-arms (the nudge is harmless)" 1 || ok "no re-arm under limit" 0
rm -f "$T/state/LIMIT"                                     # the limit clears
wait_for '[ "$(consumed)" -ge 1 ]' 30 && ok "after the limit clears, the nudge RE-ARMS the consumer" 1 || ok "re-armed after limit" 0
wait_for '[ ! -f "$LC/unconsumed.$PA" ]' 10 && ok "the flag clears once a consumer is back" 1 || ok "flag cleared" 0
grep -q "HEARTBEAT_STREAM_CONSUMED target_pane=$PA" "$LC/lifecycle.log" && ok "the recovery is logged" 1 || ok "recovery logged" 0
for p in "${WDPIDS[@]}"; do kill "$p" 2>/dev/null; done; WDPIDS=()
pkill -f "tail -n 0 -F $STREAM" 2>/dev/null

echo
echo "== B. the nudge never answers the folder-trust prompt (Enter = No, exit) =="
tmux new-session -d -s b -x 200 -y 50 -c "$T/proj" "bash '$T/agent.sh' '$STREAM' '$T/state' trust"
PB=$(tmux list-panes -t b -F '#{pane_id}')
run_wd "$PB"
sleep 10                                                   # > 3 full quiet windows at these settings
[ ! -s "$T/state/received.trust" ] && ok "NOTHING was typed into the trust dialog" 1 || ok "nothing typed into trust dialog" 0 "received: $(head -c 120 "$T/state/received.trust")"
grep -q "target_pane=$PB shows an interactive menu" "$LC/lifecycle.log" && ok "the skip is logged, not silent" 1 || ok "skip logged" 0
for p in "${WDPIDS[@]}"; do kill "$p" 2>/dev/null; done; WDPIDS=()

echo
echo "== C. claude-armed.sh starts the heartbeat itself =="
printf '#!/bin/sh\nsleep 4\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
armed_in_pane() {   # $1 = session name, $2 = extra env; the pane waits for a go-file so the id is known first
  tmux new-session -d -s "$1" -x 200 -y 50 -c "$T/proj" \
    "while [ ! -f '$T/go.$1' ]; do sleep 0.2; done; env HOME='$T/home' PATH='$T/bin:$PATH' KIJITO_REMOTE_CONTROL=0 KIJITO_LC_DIR='$LC' $2 bash '$ARMED'; touch '$T/done.$1'; sleep 60"
  tmux list-panes -t "$1" -F '#{pane_id}'
}
hb_count() { pgrep -f "heartbeat-watchdog\.sh ${1}\$" | while read -r p; do case "$PREEXISTING" in *" $p "*) ;; *) echo "$p";; esac; done | grep -c .; }

PC=$(armed_in_pane c ""); touch "$T/go.c"; sleep 2
[ "$(hb_count "$PC")" = 1 ] && ok "one watchdog is running for the pane while the session runs" 1 || ok "watchdog started" 0 "count=$(hb_count "$PC")"
wait_for '[ -f "$T/done.c" ]' 15; sleep 0.5
[ "$(hb_count "$PC")" = 0 ] && ok "and it is stopped when the session exits" 1 || ok "watchdog stopped on exit" 0 "count=$(hb_count "$PC")"

PD=$(armed_in_pane d "")
HOME="$T/home" KIJITO_LC_DIR="$LC" HEARTBEAT_POLL=300 nohup bash "$WD" "$PD" >/dev/null 2>&1 & EXT=$!; WDPIDS+=("$EXT")
sleep 0.5; touch "$T/go.d"; sleep 2
[ "$(hb_count "$PD")" = 1 ] && ok "IDEMPOTENT: an existing watchdog (e.g. a systemd unit) is not doubled" 1 || ok "idempotent" 0 "count=$(hb_count "$PD")"
wait_for '[ -f "$T/done.d" ]' 15; sleep 0.5
kill -0 "$EXT" 2>/dev/null && ok "a watchdog it did not start is NOT stopped on exit" 1 || ok "foreign watchdog left alone" 0

PE=$(armed_in_pane e "KIJITO_HEARTBEAT=0"); touch "$T/go.e"; sleep 2
[ "$(hb_count "$PE")" = 0 ] && ok "KIJITO_HEARTBEAT=0 opts out" 1 || ok "opt-out" 0

echo
echo "== U. the menu matcher =="
# shellcheck source=/dev/null
KIJITO_LC_DIR="$LC" . "$SCRIPTS/lifecycle-lib.sh"
printf ' Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n' | lc_text_is_menu \
  && ok "folder-trust dialog is a menu" 1 || ok "folder-trust dialog is a menu" 0
printf ' Is this a project you trust?\n > 1. Yes, proceed\n   2. No, exit\n' | lc_text_is_menu \
  && ok "trust dialog with an ASCII cursor is still a menu (\"No, exit\" alone decides)" 1 || ok "ascii trust dialog" 0
printf '  5-hour limit reached ∙ resets 3pm\n  /upgrade to increase your usage limit.\n\n> \n  ? for shortcuts\n' | lc_text_is_menu \
  && ok "the usage-limit screen is NOT a menu (it must stay nudgeable)" 0 || ok "the usage-limit screen is NOT a menu (it must stay nudgeable)" 1
printf '● Done. 3 files changed.\n\n> \n  ? for shortcuts\n' | lc_text_is_menu \
  && ok "an ordinary idle chat screen is NOT a menu" 0 || ok "an ordinary idle chat screen is NOT a menu" 1

echo
echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ] || exit 1
