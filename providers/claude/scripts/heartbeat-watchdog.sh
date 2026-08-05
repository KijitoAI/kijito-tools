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

_kjt_lib="${KIJITO_LC_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lifecycle-lib.sh}"
[ -f "$_kjt_lib" ] || _kjt_lib="$HOME/.claude/lifecycle-lib.sh"
# shellcheck disable=SC1090
. "$_kjt_lib" 2>/dev/null || { echo "heartbeat-watchdog: cannot source lifecycle-lib" >&2; exit 2; }

command -v tmux >/dev/null 2>&1 || { lc_log HEARTBEAT_SKIP "no tmux"; exit 0; }
[ -n "$PANE" ] || { echo "usage: heartbeat-watchdog.sh <tmux-pane-id>   (e.g. %3)" >&2; exit 2; }

# Change detection only — `cksum` is POSIX and present on both BSD and GNU userland, unlike md5sum
# (absent on macOS, where it is `md5`). We need "did this differ", not a cryptographic digest.
_pane_hash() { tmux capture-pane -p -t "$1" 2>/dev/null | tail -40 | cksum | awk '{print $1"-"$2}'; }

lc_log HEARTBEAT_START "pane=$PANE poll=${POLL}s quiet=$QUIET_CHECKS"
last=""; unchanged=0

while true; do
  sleep "$POLL"

  lc_stopped && { lc_log HEARTBEAT_SKIP "kill switch"; unchanged=0; continue; }

  # Uses the FIXED lc_pane_alive (it enumerates real pane ids). Before 0.1.4 this returned true for
  # any string, so this loop would have run forever against a pane that no longer existed.
  lc_pane_alive "$PANE" || { lc_log HEARTBEAT_EXIT "pane $PANE gone"; exit 0; }

  lc_is_armed "$PANE" || { lc_log HEARTBEAT_SKIP "pane $PANE not armed"; unchanged=0; continue; }

  cur="$(_pane_hash "$PANE")"
  [ -n "$cur" ] || { unchanged=0; continue; }
  if [ "$cur" = "$last" ]; then unchanged=$((unchanged+1)); else unchanged=0; last="$cur"; fi
  [ "$unchanged" -ge "$QUIET_CHECKS" ] || continue

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
  [ ${#_nonce} -eq 11 ] || _nonce="$(date +%s%N | cksum | tr -dc '0-9' | head -c 11)"

  # pane goes in the MESSAGE BODY, not just the lc_log prefix: that prefix is
  # built from $TMUX_PANE/$CLAUDE_CODE_SESSION_ID, which a systemd unit does
  # not have, so it renders `pane=? sid=?` in production -- 147 such lines on
  # this seat. The one context where the prefix is populated is a hand-run,
  # which is the one context that never runs in production.
  lc_log HEARTBEAT_NUDGE "pane=$PANE nonce=$_nonce idle ~$((unchanged*POLL))s"
  prompt="Backup heartbeat [wake-nonce: $_nonce]: this pane has been idle. Re-read your current-state pointer by ID (never by recall) and CONTINUE the active work autonomously to its DONE-WHEN. If your measured context is at or past the self-clear target, run the kijito-qa-memory skill and then self-clear. If there is genuinely no active work left, say so and stop."

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
