#!/usr/bin/env bash
# Shared helpers for Kijito session-lifecycle scripts. SOURCE this (`. lifecycle-lib.sh`), don't exec.
KIJITO_LC_DIR="${KIJITO_LC_DIR:-$HOME/.claude/.lifecycle}"
mkdir -p "$KIJITO_LC_DIR" 2>/dev/null
KIJITO_LC_LOG="$KIJITO_LC_DIR/lifecycle.log"
KIJITO_LC_STOP="$KIJITO_LC_DIR/STOP"

lc_now() { date +%s; }                                   # epoch (portable BSD/GNU)

lc_log() {                                               # M2 — audit log:  action [detail]
  printf '%s sid=%s pane=%s %s %s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S')" "${CLAUDE_CODE_SESSION_ID:-?}" "$(lc_self_pane 2>/dev/null || echo '?')" "$1" "${2:-}" \
    >> "$KIJITO_LC_LOG" 2>/dev/null
}

lc_stopped() { [ -f "$KIJITO_LC_STOP" ]; }              # M1 — kill switch: `touch ~/.claude/.lifecycle/STOP` halts all

# C3 — best-effort subagent guard. VERIFIED 2026-06-24: a subagent shares the parent's
# CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION / ENTRYPOINT, so there is NO reliable env
# discriminator today. This only trips on FUTURE markers and NEVER false-positives the main
# session (both are unset now). Real C3 protection = consumable QA token + kill switch.
# (The cycle cap was part of this list until 2026-07-29, when it was removed as non-discriminating —
# see self-clear.sh "C2". Do not cite it as protection.)
lc_is_child() { [ -n "${CLAUDE_AGENT_TYPE:-}" ] || [ -n "${CLAUDE_CODE_AGENT:-}" ]; }

# ── WHICH MULTIPLEXER IS THIS PANE IN: tmux, or wtmux (native Windows) ──────────────────────────
# Everything below speaks in PANE IDS, and a pane id now says which multiplexer owns it:
#   tmux   "%12"                  ($TMUX_PANE; the id tmux itself uses)
#   wtmux  "wtmux-<PID>-<PANE>"   ($WTMUX_PID + $WTMUX_PANE, e.g. wtmux-8812-1.1)
# ⛔ THE wtmux ID MUST CARRY THE SERVER PID. wtmux pane ids ("1.1") restart in every wtmux instance, so
# a marker keyed on "1.1" alone is exactly the recycled-key hazard the fingerprint below exists to stop.
# Measured on wtmux 4.0.3 (crucible, TAMALITRON, 2026-09-27): no list-panes / has-session, and
# `display-message -t` fails even for a live pane — but `capture-pane -p -t PANE` exits 0 for a live
# pane and 1 for a missing one, and `send-keys -t PANE ...` delivers. Those two verbs are all we use.
# Every wtmux call needs MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' under Git Bash, or MSYS rewrites
# "/clear" into "C:/Program Files/Git/clear" before wtmux ever sees it.
# ⚠️ tmux is keyed on $TMUX_PANE ALONE, exactly as arm-session / claude-armed / the log / the cycle file
# always were. self-clear.sh and the SessionStart hook ALSO require $TMUX for a tmux pane and check it
# themselves; folding that into this helper silently changed what every other caller accepted.
lc_self_pane() {                                         # prints THIS process's pane id; 1 = in none
  if [ -n "${TMUX_PANE:-}" ]; then printf '%s\n' "$TMUX_PANE"; return 0; fi
  if [ -n "${WTMUX_PANE:-}" ] && [ -n "${WTMUX_PID:-}" ]; then
    _lc_wt_valid "wtmux-$WTMUX_PID-$WTMUX_PANE" || return 1
    printf 'wtmux-%s-%s\n' "$WTMUX_PID" "$WTMUX_PANE"; return 0
  fi
  return 1
}
# A wtmux id is accepted only in its exact shape: a decimal pid and a dotted-decimal pane. The pane part
# reaches a command line, so nothing else may pass.
_lc_wt_valid() {
  case "$1" in wtmux-*-*) ;; *) return 1 ;; esac
  local r="${1#wtmux-}"; local pid="${r%%-*}" pn="${r#*-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$pn" in ''|*[!0-9.]*|.*|*.) return 1 ;; esac
  return 0
}
_lc_wt_pid()  { local r="${1#wtmux-}"; printf '%s' "${r%%-*}"; }
_lc_wt_pane() { local r="${1#wtmux-}"; printf '%s' "${r#*-}"; }
_lc_wtmux()   { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wtmux "$@"; }
# A wtmux command addresses the wtmux instance this process runs under; there is no verb to reach
# another one. So an id naming a DIFFERENT server pid cannot be measured from here: fail closed.
_lc_wt_reachable() {
  _lc_wt_valid "$1" || return 1
  command -v wtmux >/dev/null 2>&1 || return 1
  [ "$(_lc_wt_pid "$1")" = "${WTMUX_PID:-}" ]
}
# The start time of a native Windows process, as .NET ticks (UTC). MSYS `ps` cannot see native
# processes, so ask PowerShell. Empty output = could not measure (the caller fails closed).
_lc_proc_start() {
  local ps
  ps=$(command -v powershell.exe 2>/dev/null || command -v pwsh 2>/dev/null) || return 1
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  "$ps" -NoProfile -NonInteractive -Command \
    "(Get-Process -Id $1 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks" 2>/dev/null \
    | tr -d '\r' | awk 'NF { v = $1 } END { if (v ~ /^[0-9]+$/) print v; else exit 1 }'
}
lc_capture() {                                           # $1 = pane id; the pane's text on stdout
  if _lc_wt_valid "${1:-}"; then
    _lc_wt_reachable "$1" || return 1
    _lc_wtmux capture-pane -p -t "$(_lc_wt_pane "$1")" 2>/dev/null
  else
    tmux capture-pane -p -t "$1" 2>/dev/null
  fi
}
# Type TEXT into the pane without submitting it. tmux types it literally (-l). wtmux gets it as ONE
# argument without -l: praetor proved `send-keys -t P "/clear" Enter` on a real seat, and `-l` is
# accepted by wtmux 4.0.3 but its effect is unmeasured, so it is not relied on.
lc_send_text() {                                         # $1 = pane id, $2 = text
  if _lc_wt_valid "${1:-}"; then
    _lc_wt_reachable "$1" || return 1
    _lc_wtmux send-keys -t "$(_lc_wt_pane "$1")" "$2" 2>/dev/null
  else
    tmux send-keys -t "$1" -l -- "$2" 2>/dev/null
  fi
}
lc_send_enter() {                                        # $1 = pane id
  if _lc_wt_valid "${1:-}"; then
    _lc_wt_reachable "$1" || return 1
    _lc_wtmux send-keys -t "$(_lc_wt_pane "$1")" Enter 2>/dev/null
  else
    tmux send-keys -t "$1" Enter 2>/dev/null
  fi
}

# ⛔ THIS GATE RETURNED TRUE FOR EVERY INPUT, INCLUDING GARBAGE — IT HAD NEVER ONCE REFUSED.
# Found by argus 2026-08-01, measured on Linux tmux 3.4 AND macOS tmux 3.6a. The old body asked
# `tmux display-message -p -t "$1" '#{session_name}'` and read its EXIT CODE — but display-message
# EXITS 0 FOR A NONEXISTENT PANE, it simply prints empty fields:
#     $ tmux display-message -p -t %999 'sess=#{session_name}'   ->  "sess="   rc=0
# so `lc_pane_alive %999`, and even `lc_pane_alive nonsense`, were both TRUE.
#
# ★ WHY IT SURVIVED SO LONG: it was only ever exercised against a LIVE pane — the one input
# incapable of exposing it. A control verified solely in the direction it was designed to move is
# not verified at all. (Reproduced before fixing: %999 and "nonsense" TRUE on the old body, both
# FALSE on this one, real pane still TRUE.)
#
# ⚠️ BOUNDED HONESTLY, per argus: `send-keys` itself refuses on a dead pane, and enumerating every
# pane on the host confirmed a dead-pane /clear lands in NO pane — so this could not misfire into a
# sibling's session on a shared seat. The gate was decorative, not dangerous.
#
# ENUMERATE, DON'T ASK. `list-panes -a` is the authoritative set; `grep -Fqx` matches a whole line
# literally, so `%1` cannot match `%11` and a metacharacter in the argument cannot act as a pattern.
# Portable across BSD and GNU userland.
lc_pane_alive() {
  [ -n "${1:-}" ] || return 1
  # wtmux cannot enumerate; its capture-pane EXIT CODE is the measured liveness answer (0 live, 1 gone).
  if _lc_wt_valid "$1"; then _lc_wt_reachable "$1" && lc_capture "$1" >/dev/null; return; fi
  command -v tmux >/dev/null 2>&1 || return 1
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -Fqx -- "$1"
}

# M4 (FIXED) — a running claude pane reports pane_current_command as its VERSION (e.g. "2.1.190"),
# NOT "claude"/"node" (verified 2026-06-24). So check "not a bare shell" instead of whitelisting claude.
lc_pane_usable() {
  [ "${KIJITO_LC_TEST:-0}" = "1" ] && return 0          # test-harness escape hatch
  local c; c=$(tmux display-message -p -t "$1" '#{pane_current_command}' 2>/dev/null)
  case "$c" in ""|zsh|bash|sh|-zsh|-bash|-sh|fish|tcsh|dash) return 1 ;; *) return 0 ;; esac
}

# Arming has TWO INDEPENDENT INPUTS, and they are ORed. Keep them as separate named predicates:
# anything that REPORTS on arming, or claims to change it, must be able to say WHICH one is in force.
#   (1) per-pane marker — claude-armed.sh / arm-session.sh drop a file keyed to the pane; the hook
#       (which reliably has TMUX_PANE) reads it. Session-scoped, removable by the agent.
#   (2) KIJITO_AUTOCATCHUP=1 — a SEAT-WIDE env var, typically set in ~/.claude/settings.json, which
#       reaches every session on the host. A running process CANNOT unset it for itself, so it is not
#       revocable from inside a session at all.
# ⛔ WHY THE SPLIT EXISTS: while (2) is in force, deleting the marker changes NOTHING. `arm-session.sh
# off` did exactly that and printed "AUTONOMY OFF" — a control that reported success without acting,
# which is worse than one that errors (measured by ladybug on the Ubuntu VM 2026-08-01: with
# KIJITO_AUTOCATCHUP=1 live, `lc_is_armed %99999` — a pane that does not exist — returns ARMED).
# The only brake that works against (2) is the kill switch: touch "$KIJITO_LC_DIR/STOP".
# ⛔ A ZERO-BYTE MARKER FILE IS NOT EVIDENCE THAT *YOU* ARMED *THIS* SESSION — AND tmux PANE IDS
# RESTART AT %0 WHEN THE SERVER RESTARTS, AND RECYCLE. ladybug found 13 stale `arm.*` markers on the
# Mac (2026-08-01) with `arm.%2` matching a LIVE, UNRELATED pane. Markers are never garbage-collected
# and carry no provenance, so a fresh session landing on a low-numbered pane silently INHERITS an
# arming performed weeks ago by a different agent — and arming gates an IRREVERSIBLE `/clear`.
# ★ THE FIX IS NOT A BETTER KEY, IT IS EVIDENCE IN THE CONTENT. Any key recycles eventually (pane
# ids recycle; session NAMES recycle too — kill and recreate reuses the name). So the marker records
# the SESSION FINGERPRINT it was written against, and `lc_marker_armed` re-derives that fingerprint
# from the live tmux server on EVERY read. `#{session_created}` is immutable per session INSTANCE, so
# a server restart or a recreated session yields a different value and the stale marker stops
# validating — no GC required, and the check cannot be fooled by a coincidence of names.
# ⛔ FAIL CLOSED, DELIBERATELY: no file, an EMPTY (legacy, pre-provenance) file, an unreadable
# fingerprint, a dead pane, or any mismatch ⇒ NOT ARMED. Not-armed is the safe state — an agent that
# wants autonomy re-arms in one second, whereas a falsely-inherited arming gates a one-way wipe.
# ⚠️ UPGRADE NOTE: legacy zero-byte markers therefore stop counting. That is intended, it is the safe
# direction, and `arm-session.sh status` says so explicitly rather than reporting a bare "not armed".
# ⚠️ NOT part of the fingerprint: $CLAUDE_CODE_SESSION_ID. It ROTATES on every /clear, so validating
# against it would disarm the pane at exactly the moment the self-clear loop needs it. It is recorded
# for the audit trail only.
# wtmux has no session_name/session_created (display-message answers them EMPTY), so its fingerprint is
# the wtmux SERVER process and that process's start time: a restarted wtmux gets a new pid or, if the pid
# is reused, a new start time, and either one stops a stale marker validating.
_lc_sess_fp() {                                          # "<session_name> <session_created>"
  if _lc_wt_valid "${1:-}"; then
    local st; _lc_wt_reachable "$1" || return 1
    st=$(_lc_proc_start "$(_lc_wt_pid "$1")") || return 1
    [ -n "$st" ] || return 1
    printf 'wtmux-%s %s\n' "$(_lc_wt_pid "$1")" "$st"; return 0
  fi
  command -v tmux >/dev/null 2>&1 || return 1
  tmux display-message -p -t "$1" '#{session_name} #{session_created}' 2>/dev/null
}

lc_marker_write() {                                      # $1 = pane id (default: this pane)
  local pane="${1:-$(lc_self_pane 2>/dev/null)}" fp
  [ -n "$pane" ] || return 1
  lc_pane_alive "$pane" || return 1                      # enumerates; display-message alone exits 0 on a dead pane
  fp=$(_lc_sess_fp "$pane") || return 1
  case "$fp" in ''|' ') return 1 ;; esac
  { echo "v=1"; echo "pane=$pane"
    echo "session=${fp% *}"; echo "session_created=${fp##* }"
    echo "claude_session=${CLAUDE_CODE_SESSION_ID:-}"; echo "armed_at=$(lc_now)"
  } > "$KIJITO_LC_DIR/arm.$pane" 2>/dev/null
}

lc_marker_armed() {
  local pane="${1:-$(lc_self_pane 2>/dev/null || echo x)}" f fp want_s want_c
  f="$KIJITO_LC_DIR/arm.$pane"
  [ -s "$f" ] || return 1                                # missing OR legacy zero-byte → fail closed
  want_s=$(awk -F= '$1=="session"{sub(/^[^=]*=/,"");print}' "$f" 2>/dev/null)
  want_c=$(awk -F= '$1=="session_created"{print $2}' "$f" 2>/dev/null)
  [ -n "$want_c" ] || return 1
  lc_pane_alive "$pane" || return 1
  fp=$(_lc_sess_fp "$pane") || return 1
  [ -n "$fp" ] || return 1
  [ "$want_c" = "${fp##* }" ] && [ "$want_s" = "${fp% *}" ]
}

lc_marker_legacy() {                                     # exists but carries no provenance
  local f="$KIJITO_LC_DIR/arm.${1:-$(lc_self_pane 2>/dev/null || echo x)}"
  [ -f "$f" ] && [ ! -s "$f" ]
}

# ── M291: NEVER TYPE INTO A MENU ─────────────────────────────────────────────────────────────────
# Anything that sends keys into a pane (the heartbeat nudge above all) must first ask whether the pane
# is showing an interactive MENU rather than the chat input. The case that makes this a hard rule:
# Claude Code's folder-trust dialog, whose second option is "No, exit" — a nudge's Enter there does
# not deliver a prompt, it can QUIT the session, turning a stuck-but-recoverable pane into a dead one.
# Any numbered selection menu has the same shape (Enter picks whatever is highlighted), so the rule is
# stated for menus, with the trust dialog as the case pinned by a test.
# Reads pane TEXT on stdin (pure, so a test can drive it with fixtures); 0 = a menu is showing.
lc_text_is_menu() {
  grep -Eq -- 'No, exit|Do you trust|trust (the files in )?this folder|Enter to confirm|❯ ?[0-9]+\.'
}
lc_pane_at_menu() {                                      # $1 = pane id; the last 20 NON-BLANK-ended lines
  # ⚠️ capture-pane returns the WHOLE pane height, blank rows included, and a dialog drawn in a fresh
  # pane sits at the TOP — so a bare `tail -20` of a 50-row pane reads twenty blank lines and misses the
  # trust dialog entirely (measured by this row's own test). Trim trailing blank rows first.
  lc_capture "$1" \
    | awk '{ l[NR] = $0 } NF { last = NR } END { s = (last > 20) ? last - 19 : 1; for (i = s; i <= last; i++) print l[i] }' \
    | lc_text_is_menu
}

# ── M291: IS A BACKUP HEARTBEAT ALREADY WATCHING THIS PANE? ──────────────────────────────────────
# A watchdog's argv ENDS with its pane id (hand-run, nohup, the systemd unit's `%%%i`, and a launchd
# ProgramArguments all render `…/heartbeat-watchdog.sh %N`), so anchoring on the END is what stops
# `%1` from matching `%11`.
# ⚠️ KNOWN LIMIT: the argv names a pane, not a tmux SERVER. A seat running two tmux servers (a second
# `-L` socket) can see a watchdog for ITS `%2` as one for yours; the result is a skipped start, never a
# double one. One server per seat — the normal layout — is unaffected.
lc_heartbeat_running() {                                 # $1 = pane id
  [ -n "${1:-}" ] || return 1
  pgrep -f "heartbeat-watchdog\.sh ${1}\$" >/dev/null 2>&1
}

lc_env_armed()    { [ "${KIJITO_AUTOCATCHUP:-0}" = "1" ]; }
lc_is_armed()     { lc_marker_armed "${1:-}" || lc_env_armed; }

# ── M437: ONLY THE PANE'S OWN CLAUDE MAY AUTOSEND ────────────────────────────────────────────────
# lc_hook_owns_pane <pane> -> 0 the Claude Code process that ran this hook is the pane's own interactive
# session, 1 it is NOT (headless `-p`/`--print`, or a claude with no controlling tty - a child of some tool
# shell), 2 COULD NOT MEASURE (wtmux pane, no ps, no claude ancestor found, tmux silent, a real tty that is not
# the pane's): callers keep their old behaviour on 2, so this can only ever REMOVE a send, never block the
# loop on a host it cannot read.
# ⚠️ WHY (river, 2026-10-02): headless `claude -p` sessions run by a subagent in an ARMED pane inherited
# TMUX_PANE, so each one's SessionStart hook autosent the catch-up prompt into the live conversation.
# ⛔ NOT BY SESSION ID: /clear rotates CLAUDE_CODE_SESSION_ID (above), and the post-/clear session is the one
# that MUST autosend. What survives /clear is the terminal: the pane's claude holds #{pane_tty}; a claude
# started from a Bash-tool shell has no controlling tty at all (measured: those shells show tty "?").
lc_hook_owns_pane() {
  local pane=${1:-} p=$PPID i=0 found="" comm tty ptty tok
  local -a argv=()
  case "$pane" in ''|wtmux-*) return 2 ;; esac
  command -v ps >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1 || return 2
  while [ "$i" -lt 16 ]; do
    case "$p" in ''|*[!0-9]*) return 2 ;; esac
    [ "$p" -gt 1 ] || break
    comm=$(ps -o comm= -p "$p" 2>/dev/null) || break
    _lc_argv "$p"
    # The claude PROGRAM: its own name, or the script/entry point an interpreter runs (node .../cli.js, a
    # wrapper script named claude). Never "claude" merely appearing in a command string: a Bash-tool shell
    # whose -c text mentions claude is not one (river's review, LOW-4).
    if [ "${comm##*/}" = claude ] || [ "${argv[0]##*/}" = claude ]; then found=1; break; fi
    case "${argv[0]##*/}" in
      node|bun|bash|sh|zsh|python|python3)
        case "${argv[1]:-}" in */claude|claude|*claude-code/cli*) found=1; break ;; esac ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); i=$((i + 1))
  done
  [ -n "$found" ] || return 2
  # -p / --print as WHOLE argv tokens: a prompt that merely contains " -p " is one token, not the flag.
  for tok in "${argv[@]}"; do case "$tok" in -p|--print|--print=*) return 1 ;; esac; done
  tty=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
  case "$tty" in ''|'?'|'??'|-) return 1 ;; esac            # Linux "?", macOS "??": no controlling tty
  ptty=$(tmux display-message -p -t "$pane" '#{pane_tty}' 2>/dev/null)
  [ -n "$ptty" ] || return 2
  [ "/dev/${tty#/dev/}" = "$ptty" ] && return 0
  # A REAL tty that is not the pane's (claude under screen/script inside tmux): not one of M437's signals, so
  # "could not tell" - behave as before rather than silently stall an armed owner's loop (river, LOW-4).
  return 2
}
# _lc_argv <pid> -> sets the array argv to that process's arguments: exact tokens from /proc (Linux), else
# the ps command line split on whitespace (macOS; a quoted argument with spaces splits, which only matters
# for a prompt that contains a bare -p - the residual edge, recorded in the review).
_lc_argv() {
  argv=()
  if [ -r "/proc/$1/cmdline" ]; then
    local a
    while IFS= read -r -d '' a; do argv+=("$a"); done < "/proc/$1/cmdline"
    [ "${#argv[@]}" -gt 0 ] && return 0
  fi
  read -r -a argv <<<"$(ps -o args= -p "$1" 2>/dev/null)"
}

# qa-token is SESSION-keyed (correct: each post-/clear session must earn its OWN fresh QA pass).
lc_qa_token()   { echo "$KIJITO_LC_DIR/qa-pass.${CLAUDE_CODE_SESSION_ID:-nosession}"; }
# The cycle counter is PANE-keyed: /clear ROTATES CLAUDE_CODE_SESSION_ID (verified live: 1c5947c1→
# 6f305fa1 in the same pane %19), so a session-keyed counter would reset every clear and never
# accumulate across the self-clear loop. The pane persists across clears → accumulates correctly.
# ⚠️ Since 2026-07-29 this counter is TELEMETRY ONLY — nothing gates on it (see self-clear.sh "C2").
# It stays because the cycle number is useful in the audit log; it is not a limit.
lc_cycle_file() { echo "$KIJITO_LC_DIR/cycles.$(lc_self_pane 2>/dev/null || echo "${CLAUDE_CODE_SESSION_ID:-nosession}")"; }
