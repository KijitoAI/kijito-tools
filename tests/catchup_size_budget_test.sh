#!/usr/bin/env bash
# Does the SessionStart hook's injected text stay inside its size budget, while still carrying the four
# things an agent needs to arm its inbox correctly?
#
# WHY THIS EXISTS. session-catchup-hint.sh prints into EVERY session of EVERY user, so each character it
# adds is paid on every start, /clear and compaction, forever. 0.2.23 grew the common-case output from
# ~1,930 to ~2,940 characters by explaining the inbox waiter in the hook itself (the 30-minute Monitor cap,
# every exit code, the network-blip debounce). Nothing failed: a size regression is silent by nature, so
# only a pinned budget catches it.
#
# THE BUDGET. The common case — a producer is up for this persona and nothing is armed yet, so the hook
# tells the agent how to arm — must stay at or under COMMON_BUDGET characters. Every other branch (already
# watched, old tails, producer down, no stream for this persona, no persona marker) must stay at or under
# OTHER_BUDGET, well below the 2,600-3,100 those branches reached in 0.2.23 (measured the same way).
#
# WHAT MUST SURVIVE THE TRIM (checked in the common case):
#   · the ONE exact arm command: Bash run_in_background with `python3 -I <waiter> --persona <p> --events <s>`
#   · the rule: each time it wakes you, re-arm FIRST, then read the inbox with mark_read=false
#   · what exit 2 (NO STREAM) means
#   · a one-line Monitor fallback for hosts without background Bash
# and the detail the hook no longer carries (exit codes 3/4/5, the --grace debounce, why a bare tail is
# capture-only) must be in the waiter's --help, which the hook points at.
#
# ⚠️ MEASURED AS INSTALLED, WITH PATHS NORMALISED. The output embeds absolute paths (the waiter, the stream
# file), so a raw count depends on how long the test's temp dir happens to be (/var/folders/… on macOS is
# ~50 characters). The hook is therefore run from an installed copy under $HOME/.claude — the layout users
# actually have — and $HOME is replaced by a fixed, realistic /Users/username before counting. The persona
# is a seven-character name, and every stream layout is measured, so the budget holds for the longest path.
#
# ⛔ The hook is run with TMUX, TMUX_PANE and CLAUDE_CODE_SESSION_ID unset and a throwaway HOME: run inside
# a live armed pane it could arm autosend and type prompts into the user's terminal.
#
#   bash tests/catchup_size_budget_test.sh              # run the checks
#   bash tests/catchup_size_budget_test.sh --mutation   # ALSO prove the checks can fail
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO/providers/claude/scripts"
COMMON_BUDGET=2000
OTHER_BUDGET=2200
P=persona
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the hook parses its stdin with jq."; exit 0; }

_RUNTMP="$(mktemp -d)"; export TMPDIR="$_RUNTMP"
trap 'rm -rf "$_RUNTMP"' EXIT INT TERM

# ── shims: the same shapes catchup_topology_test.sh uses, so process state is controllable ──────────
SHIMDIR="$_RUNTMP/shims"; mkdir -p "$SHIMDIR"
cat > "$SHIMDIR/kijito-inbox-monitor" <<SHIM
#!/usr/bin/env bash
exec python3 "$REPO/providers/monitor/kijito_inbox_monitor.py" "\$@"
SHIM
cat > "$SHIMDIR/pgrep" <<'SHIM'
#!/usr/bin/env bash
pat="$*"
case "$pat" in
  *"tail -n 0 -F"*) [ "${FAKE_ARMED:-0}" = 1 ] && { printf '4241\n4242\n'; exit 0; }; exit 1 ;;
  *) [ "${FAKE_PRODUCER:-0}" = 1 ] || exit 1
     case "$pat" in
       *-af*|*-a\ *) echo "1111 /usr/bin/python3 /home/u/.local/bin/kijito-inbox-monitor --persona ${FAKE_PRODUCER_PERSONA:-someone-else} --heartbeat 900"; exit 0 ;;
       *) echo 1111; exit 0 ;;
     esac ;;
esac
SHIM
cat > "$SHIMDIR/ps" <<'SHIM'
#!/usr/bin/env bash
if [ "${1:-}" = -o ] && [ "${3:-}" = -p ]; then
  case "$2:$4" in
    comm=:4241) echo bash ;; comm=:4242) echo tail ;;
    command=:1111) [ "${FAKE_PRODUCER:-0}" = 1 ] || exit 1
                   echo "/usr/bin/python3 /home/u/.local/bin/kijito-inbox-monitor --persona ${FAKE_PRODUCER_PERSONA:-someone-else} --heartbeat 900" ;;
    etime=:4241|etime=:4242) echo "${FAKE_ARMED_AGE:-05:00}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exec /bin/ps "$@"
SHIM
cat > "$SHIMDIR/systemctl" <<'SHIM'
#!/usr/bin/env bash
case "$*" in
  *list-unit-files*kijito-inbox-monitor*) [ "${FAKE_SYSTEMD_UNIT:-0}" = 1 ] && echo "kijito-inbox-monitor@.service indirect enabled"; exit 0 ;;
esac
exit 1
SHIM
printf '#!/usr/bin/env bash\n[ "${FAKE_LAUNCHD:-0}" = 1 ] && exit 0; exit 1\n' > "$SHIMDIR/launchctl"
chmod 0755 "$SHIMDIR"/*

# A synthetic machine with the hook INSTALLED under $HOME/.claude. $1=layout (linux|mac|xdg|none),
# $2=create this persona's stream? (yes|no), $3=hook scripts dir to install from. Echoes HOME.
make_home() {
  local h ev; h="$(mktemp -d)"
  mkdir -p "$h/.claude"; cp "$3"/* "$h/.claude/"
  case "$1" in
    linux) mkdir -p "$h/.kijito-monitor";                         ev="$h/.kijito-monitor/$P.jsonl" ;;
    mac)   mkdir -p "$h/.cache/kijito-inbox-monitor";             ev="$h/.cache/kijito-inbox-monitor/events.$P.ndjson" ;;
    xdg)   mkdir -p "$h/.local/state/kijito-inbox-monitor";       ev="$h/.local/state/kijito-inbox-monitor/events.$P.ndjson" ;;
    none)  ev="" ;;
  esac
  [ "$2" = yes ] && [ -n "$ev" ] && : > "$ev"
  echo "$h"
}
PROJ="$(mktemp -d)"; echo "$P" > "$PROJ/.kijito_persona"
NOPROJ="$(mktemp -d)"

# Run the installed hook; echo its output with $HOME normalised. $1=HOME $2=project $3=source.
run_hook() {
  local out
  out="$(printf '{"source":"%s","cwd":"%s"}' "$3" "$2" \
    | env -u TMUX -u TMUX_PANE -u CLAUDE_CODE_SESSION_ID -u KIJITO_AUTOCATCHUP -u WTMUX_PANE \
          PATH="$SHIMDIR:$PATH" HOME="$1" CLAUDE_PROJECT_DIR="$2" bash "$1/.claude/session-catchup-hint.sh" 2>/dev/null)"
  printf '%s\n' "${out//$1//Users/username}"
}
chars() { printf '%s' "$1" | wc -m | tr -d ' '; }

# All checks for one build of the scripts dir. Returns 0 if every one held.
check_build() {
  local src="$1" label="$2" bad=0 h out n layout s worst=0 wl=""

  # ---- COMMON CASE: producer up for this persona, nothing armed → arming instructions ----
  for layout in linux mac xdg; do
    for s in startup clear compact; do
      h="$(make_home "$layout" yes "$src")"
      out="$(FAKE_PRODUCER=1 FAKE_PRODUCER_PERSONA=$P FAKE_ARMED=0 FAKE_SYSTEMD_UNIT=$([ $layout = linux ] && echo 1 || echo 0) \
             FAKE_LAUNCHD=$([ $layout = mac ] && echo 1 || echo 0) run_hook "$h" "$PROJ" "$s")"
      rm -rf "$h"
      if ! grep -q "producer: UP for '$P'" <<<"$out" || ! grep -q "how mail reaches this session" <<<"$out"; then
        red "$label: common case ($layout/$s) did not take the producer-UP arming branch — fixture wrong"; bad=1; continue
      fi
      n=$(chars "$out")
      [ "$n" -gt "$worst" ] && { worst=$n; wl="$layout/$s"; }
      [ "$layout:$s" = "mac:startup" ] && COMMON_OUT="$out"
    done
  done
  if [ "$worst" -le "$COMMON_BUDGET" ]; then
    grn "$label: common case ≤ $COMMON_BUDGET chars on every layout and source (largest: $worst, $wl)"
  else red "$label: common case is $worst chars ($wl), over the $COMMON_BUDGET budget"; bad=1; fi

  # ---- what the trimmed common case must still say ----
  out="$COMMON_OUT"
  local ev="/Users/username/.cache/kijito-inbox-monitor/events.$P.ndjson"
  local arm="Bash(command=\"python3 -I '/Users/username/.claude/kijito-inbox-wait.py' --persona '$P' --events '$ev'\", run_in_background=true)"
  if [ "$(grep -cF "$arm" <<<"$out")" = 1 ] && [ "$(grep -c 'Bash(command=' <<<"$out")" = 1 ]; then
    grn "$label: exactly one arm command, the background-Bash waiter on this persona's stream"
  else red "$label: the single exact arm command is missing or duplicated: $(grep 'Bash(' <<<"$out")"; bad=1; fi
  if grep -q "RE-ARM IT FIRST" <<<"$out" && grep -qF "kijito_hive_inbox(persona=\"$P\", unread_only=true, mark_read=false)" <<<"$out"; then
    grn "$label: the re-arm-first-then-read rule names the mark_read=false read"
  else red "$label: the re-arm rule or the mark_read=false read is gone"; bad=1; fi
  if grep -q "Exit 2 = NO STREAM" <<<"$out"; then grn "$label: exit 2 (no stream) is explained"
  else red "$label: the hook no longer says what exit 2 means"; bad=1; fi
  if [ "$(grep -c '^  Monitor(command="tail -n 0 -F ' <<<"$out")" = 1 ] && grep -q "30 MINUTES" <<<"$out" \
     && grep -qF "Monitor(command=\"tail -n 0 -F $ev | grep --line-buffered" <<<"$out"; then
    grn "$label: one single-line Monitor fallback on the same stream, with its 30-minute cap"
  else red "$label: the one-line Monitor fallback is missing or malformed"; bad=1; fi
  if grep -q -- "--help" <<<"$out"; then grn "$label: the hook points at the waiter's --help for the rest"
  else red "$label: the hook does not say where the full explanation lives"; bad=1; fi

  # ---- the moved detail actually landed in the waiter's --help ----
  local help; help="$(python3 -I "$src/kijito-inbox-wait.py" --help 2>&1)"
  if grep -qE "^  3 " <<<"$help" && grep -qE "^  4 " <<<"$help" && grep -qE "^  5 " <<<"$help" \
     && grep -q -- "--grace" <<<"$help" && grep -q "DEBOUNCE" <<<"$help" && grep -q "CAPTURE-ONLY" <<<"$help"; then
    grn "$label: waiter --help carries exits 3/4/5, the --grace debounce and why a bare tail is capture-only"
  else red "$label: waiter --help is missing the detail the hook moved out"; bad=1; fi

  # ---- every other branch: no larger than OTHER_BUDGET ----
  local name want env_set proj layout2 mkev src2
  while IFS='|' read -r name want layout2 mkev proj src2 env_set; do
    [ -n "$name" ] || continue
    h="$(make_home "$layout2" "$mkev" "$src")"
    # shellcheck disable=SC2086  # env_set is a list of VAR=value words, split on purpose
    out="$(export $env_set; run_hook "$h" "$([ "$proj" = yes ] && echo "$PROJ" || echo "$NOPROJ")" "$src2")"
    rm -rf "$h"
    if ! grep -qF "$want" <<<"$out"; then
      red "$label: branch '$name' fixture did not produce '$want' — measured nothing"; bad=1; continue
    fi
    n=$(chars "$out")
    if [ "$n" -le "$OTHER_BUDGET" ]; then grn "$label: $name ≤ $OTHER_BUDGET chars ($n)"
    else red "$label: $name is $n chars, over the $OTHER_BUDGET budget"; bad=1; fi
  done <<EOF
already watched|ALREADY WATCHED|mac|yes|yes|startup|FAKE_PRODUCER=1 FAKE_PRODUCER_PERSONA=$P FAKE_ARMED=1 FAKE_LAUNCHD=1
already watched, old tails, after /clear|YOUR OWN pre-reset|xdg|yes|yes|clear|FAKE_PRODUCER=1 FAKE_PRODUCER_PERSONA=$P FAKE_ARMED=1 FAKE_ARMED_AGE=1-02:03:04
producer down|producer: DOWN|xdg|no|yes|startup|FAKE_PRODUCER=0 FAKE_ARMED=0
no stream for this persona|NOT for '$P'|xdg|no|yes|startup|FAKE_PRODUCER=1 FAKE_PRODUCER_PERSONA=someone-else FAKE_ARMED=0
no persona marker|No .kijito_persona marker|xdg|no|no|startup|FAKE_PRODUCER=0 FAKE_ARMED=0
EOF
  return $bad
}

echo "catch-up hook size budget (common ≤ $COMMON_BUDGET, other branches ≤ $OTHER_BUDGET chars):"
check_build "$SCRIPTS" "hook"

# --- mutation: prove the checks can fail --------------------------------------------------------
# Two real regression shapes, each on its own copy of the scripts dir:
#  (1) the 0.2.23 growth: the waiter explanation pasted back into the arming block → the budget must fail;
#  (2) the trim going too far: the exit-2 line dropped → the content check must fail.
# Each mutant is verified to contain its change before its kill is believed.
if [ "${1:-}" = "--mutation" ]; then
  echo
  echo "mutation (each mutant MUST fail the checks above):"
  mutate() {  # $1=label $2=anchor $3=replacement
    local d; d="$(mktemp -d)"; cp "$SCRIPTS"/* "$d/"
    if ! MUT_F="$d/session-catchup-hint.sh" MUT_A="$2" MUT_B="$3" python3 - <<'PYMUT'
import os, sys
f = os.environ["MUT_F"]; s = open(f, encoding="utf-8").read(); a = os.environ["MUT_A"]
if s.count(a) != 1:
    sys.stderr.write("anchor matched %d times\n" % s.count(a)); sys.exit(1)
open(f, "w", encoding="utf-8").write(s.replace(a, os.environ["MUT_B"], 1))
PYMUT
    then red "mutation '$1': the mutant could not be built (anchor missing?) — proves nothing"; rm -rf "$d"; return; fi
    if ! bash -n "$d/session-catchup-hint.sh"; then red "mutation '$1': the mutant does not parse"; rm -rf "$d"; return; fi
    local _p=$pass _f=$fail mrc
    check_build "$d" "MUTANT" >/dev/null 2>&1; mrc=$?
    pass=$_p; fail=$_f
    [ "$mrc" -ne 0 ] && grn "mutation killed — $1" || red "mutation SURVIVED — $1: the checks test nothing"
    rm -rf "$d"
  }
  mutate "the 0.2.23 waiter explanation pasted back into the arming block" \
    'EACH TIME IT WAKES YOU: RE-ARM IT FIRST' \
    'It blocks until the first wake-worthy event on your stream, prints it and EXITS, and that exit is
what re-invokes you. Background Bash has no time limit. It sleeps through network blips (a "source is
DOWN" alert that recovers within 10 min; add --grace 0 to wake on every alert) and refuses to start a
second waiter on the same stream (exit 4: already watched, arm nothing). Exit 2 = NO STREAM: the
producer is not running, and the line it prints says how to start it.
EACH TIME IT WAKES YOU: RE-ARM IT FIRST'
  mutate "the exit-2 explanation dropped" 'Exit 2 = NO STREAM: nothing writes' 'Nothing writes'
fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
