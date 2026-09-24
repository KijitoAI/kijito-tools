#!/usr/bin/env bash
# BACKUP heartbeat for an armed autonomous pane. (Jason, 2026-08-01: "please also setup a backup
# heartbeat.")
#
#   ~/.claude/heartbeat-watchdog.sh %3 &        # or run under systemd/launchd; see WIRING below
#
# WHAT THE PRIMARY IS, so this stays a BACKUP and never competes with it: after a /clear the
# SessionStart hook runs `session-autosend.sh`, which injects the catch-up prompt and restarts the
# loop. That path owns the normal case. This covers only what it cannot — the pane going QUIET
# WITHOUT a /clear: a turn that ended without queueing the next one, a crashed send, an agent that
# reported and then simply stopped.
#
# ⛔ THE DANGER IS FIRING WHILE THE AGENT IS ALIVE, so every guard is biased toward NOT sending. A
# spurious nudge injects a prompt into a working session; a missed nudge costs idle time. Those are
# not symmetric.
#   * ARMED-ONLY, FAIL CLOSED. An unarmed pane is human-managed and must never be poked; if
#     armed-ness cannot be established, do nothing.
#   * KILL SWITCH honoured every cycle, not just at startup.
#   * IDLE = the pane's visible output byte-identical for QUIET_CHECKS consecutive polls (default
#     4 x 300s = 20 min). A working session repaints constantly — spinner, tool output, streaming
#     text — so 20 minutes unchanged is a strong signal, deliberately far above any normal gap.
#   * ONE NUDGE PER QUIET WINDOW — not one per episode, and the distinction is deliberate. After a
#     nudge the counter resets and the baseline is retaken, so a pane that STAYS idle is nudged
#     again one full window later (20 min at defaults), not on every poll. That is the right
#     behaviour for a heartbeat: if the first nudge did not restart anything, the pane is still
#     stuck and still needs help. Measured at test speeds (POLL=1, QUIET=2): 3 nudges in 11s, i.e.
#     one per window, which is exactly one per 20 min at production settings.
#
# ⚠️ THE PROMPT IT SENDS IS SAFE TO RECEIVE AT ANY MOMENT — it asks the agent to continue from its
# own pointer, which is nearly a no-op for a session already doing that. That property is what makes
# a false positive cheap; do not replace it with a directive that assumes idleness.
#
# WIRING (either host; the script itself is host-agnostic):
#   Linux/systemd :  systemd --user unit with ExecStart=%h/.claude/heartbeat-watchdog.sh <pane>
#   macOS/launchd :  a LaunchAgent with the same ExecStart, or simply `nohup ... &` from the pane.
set -u

PANE="${1:-}"
POLL="${HEARTBEAT_POLL:-300}"
QUIET_CHECKS="${HEARTBEAT_QUIET:-4}"
# M291: how long a persona's event stream may carry unread wake events with NO consumer before this
# says so. Default 10 min: longer than a Monitor re-arm gap, far shorter than a usage-limit outage.
UNCONSUMED_SECS="${HEARTBEAT_UNCONSUMED_SECS:-600}"

_kjt_lib="${KIJITO_LC_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lifecycle-lib.sh}"
[ -f "$_kjt_lib" ] || _kjt_lib="$HOME/.claude/lifecycle-lib.sh"
# shellcheck disable=SC1090
. "$_kjt_lib" 2>/dev/null || { echo "heartbeat-watchdog: cannot source lifecycle-lib" >&2; exit 2; }

_kjt_plib="$(dirname "$_kjt_lib")/kijito-persona-lib.sh"
[ -f "$_kjt_plib" ] || _kjt_plib="$HOME/.claude/kijito-persona-lib.sh"
# shellcheck disable=SC1090
. "$_kjt_plib" 2>/dev/null || true      # optional: without it the stream check is skipped, not faked

command -v tmux >/dev/null 2>&1 || { lc_log HEARTBEAT_SKIP "no tmux"; exit 0; }
[ -n "$PANE" ] || { echo "usage: heartbeat-watchdog.sh <tmux-pane-id>   (e.g. %3)" >&2; exit 2; }

# Change detection only — `cksum` is POSIX and present on both BSD and GNU userland, unlike md5sum
# (absent on macOS, where it is `md5`). We need "did this differ", not a cryptographic digest.
_pane_hash() { tmux capture-pane -p -t "$1" 2>/dev/null | tail -40 | cksum | awk '{print $1"-"$2}'; }

# ── M291: THE UNCONSUMED-STREAM CHECK ────────────────────────────────────────────────────────────
# WHY: a Claude usage-limit hit ends the agent's turn loop, and the wake-capable consumer (a Monitor
# tail) dies or expires with it. When the limit clears NOTHING re-arms it: the producer keeps writing
# events, nobody reads them, and the session is permanently deaf while every health signal reads
# green (producer up, heartbeat fresh, mail landing). That is DIFFERENT from the producer's "dormant
# inbox" notice, which is about mail nobody has READ on the server; this is about a local stream
# nobody is CONSUMING — and it has a different fix (re-arm the consumer), so it gets its own name.
#
# RAISED WHEN: this pane's persona has an event stream, no `tail` consumer has been attached for
# UNCONSUMED_SECS, AND at least one wake-worthy event was appended since the consumer went missing
# (no events = nothing missed = nothing to alarm about; the heartbeat rows the producer writes every
# minute are excluded by the same filter a consumer uses).
# SURFACED AS: an `HEARTBEAT_UNCONSUMED_STREAM` lifecycle-log line, a flag file the status line shows
# (`unconsumed.<pane>`), and a nudge prompt that says to re-arm the consumer FIRST. Cleared (with a
# `HEARTBEAT_STREAM_CONSUMED` line) the moment a consumer is attached again.
WAKE_EVENTS='"event": ?"(new|alert|recovered|state_corrupt|baseline_skipped|seed_ahead|replay_capped|persona_added|still_unread)"'
UNCONSUMED_FLAG="$KIJITO_LC_DIR/unconsumed.$PANE"
st_missing_since=""; st_offset=""; st_alerted=0; st_path=""

_stream_check() {
  command -v kijito_stream_for_persona >/dev/null 2>&1 || return 0
  local dir persona path now size n
  dir=$(tmux display-message -p -t "$PANE" '#{pane_current_path}' 2>/dev/null)
  persona=$(kijito_persona_from_marker "$dir" 2>/dev/null) || persona=""
  [ -n "$persona" ] || return 0
  path=$(kijito_stream_for_persona "$persona" 2>/dev/null) || path=""
  [ -n "$path" ] && [ -f "$path" ] || return 0
  if kijito_stream_consumed "$path"; then
    if [ "$st_alerted" = 1 ]; then lc_log HEARTBEAT_STREAM_CONSUMED "target_pane=$PANE persona=$persona stream=$path"; fi
    rm -f "$UNCONSUMED_FLAG" 2>/dev/null
    st_missing_since=""; st_offset=""; st_alerted=0; st_path=""
    return 0
  fi
  now=$(lc_now); size=$(wc -c < "$path" 2>/dev/null | tr -d ' ')
  if [ -z "$st_missing_since" ] || [ "$path" != "$st_path" ]; then
    st_missing_since=$now; st_offset=$size; st_path=$path; return 0
  fi
  # the producer self-rotates its stream; a shrunken file means everything in it is new
  [ "${size:-0}" -lt "${st_offset:-0}" ] && st_offset=0
  [ "$st_alerted" = 0 ] || return 0
  [ $((now - st_missing_since)) -ge "$UNCONSUMED_SECS" ] || return 0
  n=$(tail -c +"$((st_offset + 1))" "$path" 2>/dev/null | grep -cE -- "$WAKE_EVENTS")
  [ "${n:-0}" -gt 0 ] || return 0
  st_alerted=1
  lc_log HEARTBEAT_UNCONSUMED_STREAM "target_pane=$PANE persona=$persona stream=$path events=$n no_consumer_for=$((now - st_missing_since))s"
  printf 'persona=%s\nstream=%s\nevents=%s\nsince=%s\n' "$persona" "$path" "$n" "$st_missing_since" > "$UNCONSUMED_FLAG" 2>/dev/null
}

lc_log HEARTBEAT_START "pane=$PANE poll=${POLL}s quiet=$QUIET_CHECKS"
last=""; unchanged=0

while true; do
  sleep "$POLL"

  lc_stopped && { lc_log HEARTBEAT_SKIP "kill switch"; unchanged=0; continue; }

  # Uses the FIXED lc_pane_alive (it enumerates real pane ids). Before 0.1.4 this returned true for
  # any string, so this loop would have run forever against a pane that no longer existed.
  lc_pane_alive "$PANE" || { lc_log HEARTBEAT_EXIT "pane $PANE gone"; exit 0; }

  lc_is_armed "$PANE" || { lc_log HEARTBEAT_SKIP "pane $PANE not armed"; unchanged=0; continue; }

  _stream_check

  cur="$(_pane_hash "$PANE")"
  [ -n "$cur" ] || { unchanged=0; continue; }
  if [ "$cur" = "$last" ]; then unchanged=$((unchanged+1)); else unchanged=0; last="$cur"; fi
  [ "$unchanged" -ge "$QUIET_CHECKS" ] || continue

  # ⛔ M291: NEVER TYPE INTO A MENU. The folder-trust dialog's second option is "No, exit"; an Enter
  # there does not deliver the nudge, it can END the session. Checked AFTER the idle window so a
  # quiet pane sitting on a dialog is logged once per window, not on every poll — and nothing is sent.
  if lc_pane_at_menu "$PANE"; then
    lc_log HEARTBEAT_SKIP "target_pane=$PANE shows an interactive menu (e.g. folder trust, where Enter = No, exit); not typing into it"
    unchanged=0; last="$(_pane_hash "$PANE")"
    continue
  fi

  # ── WAKE NONCE ────────────────────────────────────────────────────────────
  # Every nudge carries an identity. Without one, EVERY heartbeat nudge is
  # BYTE-IDENTICAL to every other heartbeat nudge, which breaks three things
  # that were each reported separately as if they were different bugs:
  #   1. D1 cannot tell nudge #1 from nudge #47, so nudges are invisible to
  #      the wake population by construction.
  #   2. Content-identity attribution collapses them onto one another -- the
  #      same duplicate-payload hazard found in the D1 batch keys (L3-F2).
  #   3. Byte-identical NUDGE log lines at the same timestamp cannot be
  #      resolved into "two panes coinciding" vs "one pane double-firing",
  #      so a double-fire is a real bug the log is structurally unable to
  #      reveal (argus).
  #
  # RANDOM, not derived -- and this is the ONE place in the design where that
  # is correct. The derived-nonce ruling covers producer events, which have an
  # `event_id` to derive FROM and an equivalence class where a re-delivery is
  # the SAME wake. A nudge has no event and no dedupe key: one EMISSION is one
  # wake (signal-class), so a per-emission identity is the right semantics.
  #
  # 11 base62 chars matches the producer's wake nonce exactly: 10 chars is
  # 59.5 bits (under the >=64-bit floor), 12 breaks the <=11 ceiling.
  _nonce="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 11)"
  if [ ${#_nonce} -ne 11 ]; then
    # DEGRADED GENERATOR -- and it must ANNOUNCE itself. The fallback is
    # `date+cksum`, ~36 bits, BELOW the >=64-bit floor the plan sets. A weak
    # nonce is byte-indistinguishable from a strong one at the point of use,
    # so a silent downgrade is the false-calm shape this whole file exists to
    # remove: collisions would surface far downstream as two wakes that look
    # like one, and nothing would point back here. (assay, review of 225cc0e.)
    _nonce="$(date +%s%N | cksum | tr -dc '0-9' | head -c 11)"
    lc_log HEARTBEAT_NONCE_DEGRADED "urandom unavailable; ~36-bit fallback nonce=$_nonce"
  fi

  # The pane goes in the MESSAGE BODY, not just the lc_log prefix: that prefix
  # is built from $TMUX_PANE/$CLAUDE_CODE_SESSION_ID, which a systemd unit does
  # not have, so it renders `pane=? sid=?` in production -- 147 such lines on
  # this seat. The one context where the prefix IS populated is a hand-run,
  # which is the one context that never runs in production.
  #
  # ⚠️ IT IS `target_pane=`, NOT `pane=`, AND THAT IS NOT COSMETIC (cadence,
  # caught pre-install). lc_log ALWAYS emits `pane=` in its prefix, so a body
  # field of the same name puts TWO `pane=` on one line:
  #     … sid=? pane=?  HEARTBEAT_NUDGE  pane=%4 nonce=…
  # and `grep -o 'pane=[^ ]*'` returns the PREFIX one -- `pane=?` -- because
  # it comes first. A consumer parsing naively would read "pane unknown" on
  # precisely the lines this change exists to make attributable. That is one
  # label with two meanings on a single line, which is the defect class this
  # fleet has hit repeatedly; a distinct name avoids it without touching the
  # shared lc_log prefix, whose blast radius is every log line we emit.
  lc_log HEARTBEAT_NUDGE "target_pane=$PANE nonce=$_nonce idle ~$((unchanged*POLL))s"
  prompt="Backup heartbeat [wake-nonce: $_nonce]: this pane has been idle. Make sure your wake-capable inbox consumer is armed (a usage-limit outage ends it silently). Re-read your current-state pointer by ID (never by recall) and CONTINUE the active work autonomously to its DONE-WHEN. If your measured context is at or past the self-clear target, run the kijito-qa-memory skill and then self-clear. If there is genuinely no active work left, say so and stop."
  if [ "$st_alerted" = 1 ]; then
    prompt="Backup heartbeat [wake-nonce: $_nonce]: YOUR INBOX IS DEAF - the event stream $st_path has unread wake events and NO consumer is reading it. FIRST re-arm your wake-capable inbox consumer on that file (a usage-limit outage ends it silently), then read your inbox. Then re-read your current-state pointer by ID (never by recall) and CONTINUE the active work to its DONE-WHEN. If your measured context is at or past the self-clear target, run the kijito-qa-memory skill and then self-clear."
  fi

  # Same paste-buffer discipline as session-autosend: a gap before the Enter, then verify, because
  # an Enter inside the TUI's ingest burst is absorbed as a newline and the nudge would sit unsent —
  # a backup heartbeat that silently fails to fire is worse than none, since it is trusted.
  tmux send-keys -t "$PANE" -l -- "$prompt" 2>/dev/null
  sleep "${KIJITO_SEND_SETTLE:-1.2}"
  probe=$(printf '%s' "$prompt" | tail -c 40)
  for _try in 1 2 3; do
    tmux send-keys -t "$PANE" Enter 2>/dev/null
    sleep 1.5
    tmux capture-pane -p -t "$PANE" 2>/dev/null | tail -6 | grep -qF -- "$probe" || break
  done

  unchanged=0
  last="$(_pane_hash "$PANE")"
done
