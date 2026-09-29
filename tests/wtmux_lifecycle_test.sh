#!/usr/bin/env bash
# Does the self-clear loop work inside wtmux, the tmux stand-in on NATIVE WINDOWS?
#
# WHY THIS EXISTS. praetor and crucible run Claude Code on Windows gaming PCs inside wtmux (not tmux).
# Every lifecycle script asked for $TMUX_PANE and spoke tmux verbs, so arming, self-clear and the
# post-/clear resume all refused there ("not in tmux"), and praetor kept a hand-written stand-in
# (crucible hive 10710/10713, 2026-09-27).
#
# WHAT wtmux 4.0.3 CAN DO (measured by crucible on TAMALITRON): capture-pane -p -t PANE (exit 0 live,
# exit 1 "window N not found" for a missing pane) and send-keys -t PANE ... . It has NO list-panes /
# has-session, display-message -t fails, and every call from Git Bash needs MSYS_NO_PATHCONV=1 and
# MSYS2_ARG_CONV_EXCL='*' or "/clear" is rewritten into a Windows path.
#
# ⛔ THE PROPERTIES UNDER TEST:
#   1. The wtmux pane id carries the SERVER PID (wtmux pane ids like "1.1" repeat in every instance).
#   2. An arm marker validates only against the SAME wtmux server instance: a restarted server (new start
#      time, even on a reused pid) or another server's pid does NOT inherit the arming.
#   3. Anything we cannot measure (no PowerShell, no wtmux, another server) fails CLOSED: not armed.
#   4. Every wtmux call carries the two MSYS variables, and text is sent without -l.
#   5. tmux still wins when both are present (a tmux inside a wtmux pane is the pane that matters).
#
# HOW. There is no Windows here, so `wtmux` and `powershell.exe` are shimmed on PATH; the shipped
# scripts run byte-for-byte.
#
#   bash tests/wtmux_lifecycle_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SD="$REPO/providers/claude/scripts"
LIB="$SD/lifecycle-lib.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
BIN="$T/bin"; NOPS="$T/nops"; NOWT="$T/nowt"; mkdir -p "$BIN" "$NOPS" "$NOWT"
# Fake wtmux: panes listed in $T/panes are live; every call is logged with the two MSYS variables.
cat > "$BIN/wtmux" <<SHIM
#!/usr/bin/env bash
printf 'NOPATHCONV=%s EXCL=%s ARGS=%s\n' "\${MSYS_NO_PATHCONV:-}" "\${MSYS2_ARG_CONV_EXCL:-}" "\$*" >> "$T/wtmux.log"
verb="\$1"; shift; tgt=""
while [ \$# -gt 0 ]; do case "\$1" in -t) tgt="\$2"; shift 2 ;; *) break ;; esac; done
[ "\$verb" = capture-pane ] && { [ "\$1" = -p ] || exit 2; shift; while [ \$# -gt 0 ]; do case "\$1" in -t) tgt="\$2"; shift 2 ;; *) shift ;; esac; done; }
grep -Fqx -- "\$tgt" "$T/panes" 2>/dev/null || { echo "window \${tgt%%.*} not found" >&2; exit 1; }
case "\$verb" in
  capture-pane) cat "$T/screen" 2>/dev/null; exit 0 ;;
  send-keys)    exit 0 ;;
  *)            echo "unknown command: \$verb" >&2; exit 1 ;;
esac
SHIM
# Fake PowerShell: the start time of the wtmux server, CRLF-terminated like the real thing.
cat > "$BIN/powershell.exe" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T/ps.log"
[ -f "$T/start" ] || { echo "Get-Process : Cannot find a process with the process identifier" >&2; exit 1; }
printf '%s\r\n' "\$(cat "$T/start")"
SHIM
chmod +x "$BIN/wtmux" "$BIN/powershell.exe"
cp "$BIN/wtmux" "$NOPS/wtmux"                    # a host with wtmux but no PowerShell
cp "$BIN/powershell.exe" "$NOWT/powershell.exe"  # a host with PowerShell but no wtmux
# A PATH THAT CANNOT FIND POWERSHELL, even on a host that ships it: GitHub's ubuntu runners carry
# /usr/bin/pwsh, so "prepend a shim dir without PowerShell" still found the real one there, it answered 0,
# and the could-not-measure cases read DOWN (CI, 2026-09-29). Mirror every tool on PATH except PowerShell.
_nops_sys() {  # $1 = dir to fill
  local d f n; mkdir -p "$1"
  local IFS=:
  for d in $PATH; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      n=${f##*/}
      case "$n" in pwsh|pwsh.exe|pwsh-*|powershell|powershell.exe) continue ;; esac
      [ -x "$f" ] && [ ! -e "$1/$n" ] && ln -s "$f" "$1/$n"
    done
  done
}
SYS="$T/sys"; _nops_sys "$SYS"
echo "1.1" > "$T/panes"; echo "638000000000000001" > "$T/start"; : > "$T/screen"

export KIJITO_LC_DIR="$T/lc" CLAUDE_CODE_SESSION_ID=wtsess
mkdir -p "$KIJITO_LC_DIR"
W() {  # run in a wtmux pane: $1 = PATH prefix, rest = command
  local p="$1"; shift
  env -u TMUX -u TMUX_PANE -u KIJITO_AUTOCATCHUP WTMUX=1 WTMUX_PID="${WPID:-8812}" WTMUX_PANE="${WPANE:-1.1}" \
    PATH="$p:$SYS" KIJITO_LC_LIB="$LIB" "$@"
}
lib() { local p="$1"; shift; W "$p" bash -c '. "$0"; "$@"' "$LIB" "$@"; }
ID="wtmux-8812-1.1"

echo "wtmux lifecycle checks:"
# ── 1. the pane id ───────────────────────────────────────────────────────────────────────────────
got=$(lib "$BIN" lc_self_pane); [ "$got" = "$ID" ] && grn "lc_self_pane names the wtmux pane WITH the server pid ($got)" || red "lc_self_pane: '$got'"
got=$(WPANE='1.1;id' lib "$BIN" lc_self_pane; echo "rc=$?"); [ "$got" = "rc=1" ] && grn "a WTMUX_PANE with shell metacharacters is refused" || red "hostile pane accepted: $got"
got=$(WPID='88x' lib "$BIN" lc_self_pane; echo "rc=$?"); [ "$got" = "rc=1" ] && grn "a non-numeric WTMUX_PID is refused" || red "non-numeric pid accepted: $got"
got=$(env TMUX=/tmp/x,1,0 TMUX_PANE=%7 WTMUX_PID=8812 WTMUX_PANE=1.1 bash -c '. "$0"; lc_self_pane' "$LIB")
[ "$got" = "%7" ] && grn "tmux wins when both are set (tmux inside a wtmux pane)" || red "precedence: '$got'"
got=$(env -u TMUX -u TMUX_PANE -u WTMUX_PID -u WTMUX_PANE bash -c '. "$0"; lc_self_pane; echo "rc=$?"' "$LIB")
[ "$got" = "rc=1" ] && grn "outside any multiplexer: no pane (rc 1)" || red "no-mux: '$got'"

# The CI regression of 2026-09-29: $TMUX_PANE WITHOUT $TMUX. The pane is still named (arm-session,
# claude-armed, the log and the cycle file always keyed on $TMUX_PANE alone), but self-clear and the hook
# also require $TMUX for a tmux pane and must keep refusing. A run from inside a real tmux hid this.
got=$(env -u TMUX -u WTMUX_PID -u WTMUX_PANE TMUX_PANE=%7 bash -c '. "$0"; lc_self_pane' "$LIB")
[ "$got" = "%7" ] && grn "TMUX_PANE alone still names the tmux pane (the pre-wtmux contract)" || red "TMUX_PANE alone: '$got'"
out=$(env -u TMUX -u WTMUX_PID -u WTMUX_PANE -u KIJITO_AUTOCATCHUP TMUX_PANE=%7 KIJITO_LC_LIB="$LIB" bash "$SD/self-clear.sh" 2>&1); rc=$?
[ $rc = 4 ] && grn "self-clear still refuses a tmux pane id without \$TMUX (4)" || red "TMUX_PANE-only self-clear: rc=$rc $out"

# ── 2. liveness = capture-pane's exit code ──────────────────────────────────────────────────────
lib "$BIN" lc_pane_alive "$ID" && grn "live wtmux pane is alive" || red "live pane read dead"
lib "$BIN" lc_pane_alive "wtmux-8812-3.1" && red "missing pane read ALIVE" || grn "missing pane (capture-pane exit 1) is dead"
lib "$BIN" lc_pane_alive "wtmux-4242-1.1" && red "ANOTHER server's pane read alive" || grn "a pane of another wtmux server cannot be measured → not alive"
lib "/nonexistent" lc_pane_alive "$ID" && red "no wtmux binary read alive" || grn "no wtmux binary → not alive"

# ── 3. the arm marker: written against THIS server instance, re-validated on every read ────────
: > "$T/wtmux.log"
lib "$BIN" lc_marker_write "$ID" && grn "marker written for a live wtmux pane" || red "marker write failed"
f="$KIJITO_LC_DIR/arm.$ID"
grep -qx "session=wtmux-8812" "$f" && grep -qx "session_created=638000000000000001" "$f" \
  && grn "marker carries the server pid + its start time" || red "marker content: $(cat "$f")"
lib "$BIN" lc_marker_armed "$ID" && grn "marker validates on the same server" || red "own marker did not validate"
echo "638000000000000999" > "$T/start"
lib "$BIN" lc_marker_armed "$ID" && red "a RESTARTED server (reused pid) inherited the arming" || grn "restarted server (new start time, same pid) → NOT armed"
echo "638000000000000001" > "$T/start"
WPID=4242 lib "$BIN" lc_marker_armed "$ID" && red "armed from another server" || grn "another wtmux server cannot validate this marker"
lib "$NOPS" lc_marker_armed "$ID" && red "armed with no PowerShell to measure the fingerprint" || grn "no PowerShell → cannot measure → NOT armed (fail closed)"
rm -f "$T/start"
lib "$BIN" lc_marker_armed "$ID" && red "armed although the server process is gone" || grn "server process gone → NOT armed"
echo "638000000000000001" > "$T/start"
if grep -v 'NOPATHCONV=1 EXCL=\*' "$T/wtmux.log" | grep -q .; then red "a wtmux call ran without the MSYS variables: $(grep -v 'NOPATHCONV=1 EXCL=\*' "$T/wtmux.log" | head -1)"
else grn "every wtmux call carried MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'"; fi

# ── 4. arm-session.sh, end to end ───────────────────────────────────────────────────────────────
rm -f "$f"
out=$(W "$BIN" bash "$SD/arm-session.sh" on 2>&1); rc=$?
[ $rc = 0 ] && [ -s "$f" ] && grn "arm-session.sh on arms a wtmux pane" || red "arm-session on: rc=$rc $out"
out=$(W "$BIN" bash "$SD/arm-session.sh" status 2>&1)
grep -q "pane=$ID marker=yes" <<<"$out" && grep -q "^armed" <<<"$out" && grn "arm-session.sh status: armed by marker" || red "status: $out"
out=$(env -u TMUX -u TMUX_PANE -u WTMUX_PID -u WTMUX_PANE KIJITO_LC_LIB="$LIB" bash "$SD/arm-session.sh" on 2>&1); rc=$?
[ $rc = 1 ] && grep -q "not in tmux or wtmux" <<<"$out" && grn "outside any multiplexer arm-session refuses (rc 1)" || red "no-mux arm: rc=$rc $out"

# ── 5. self-clear.sh, end to end ────────────────────────────────────────────────────────────────
tok="$KIJITO_LC_DIR/qa-pass.wtsess"
date +%s > "$tok"; : > "$T/wtmux.log"
out=$(W "$BIN" env KIJITO_SELFCLEAR_DELAY=0.2 KIJITO_SEND_SETTLE=0.2 KIJITO_MYCTX=/nonexistent bash "$SD/self-clear.sh" 2>&1); rc=$?
[ $rc = 0 ] && grep -q "/clear → $ID" <<<"$out" && grn "self-clear accepts an armed wtmux pane" || red "self-clear: rc=$rc $out"
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q SELFCLEAR_DONE "$KIJITO_LC_DIR/lifecycle.log" 2>/dev/null && break; sleep 0.3; done
if grep -qx 'NOPATHCONV=1 EXCL=\* ARGS=send-keys -t 1.1 /clear' "$T/wtmux.log" \
   && grep -qx 'NOPATHCONV=1 EXCL=\* ARGS=send-keys -t 1.1 Enter' "$T/wtmux.log"; then
  grn "self-clear typed /clear (no -l) then Enter into pane 1.1, with the MSYS variables"
else red "self-clear keys: $(cat "$T/wtmux.log")"; fi
grep -q "pane=$ID SELFCLEAR_DONE" "$KIJITO_LC_DIR/lifecycle.log" && grn "audit log: SELFCLEAR_DONE on the wtmux pane id" || red "log: $(tail -3 "$KIJITO_LC_DIR/lifecycle.log")"
[ -f "$tok" ] && red "qa token not consumed" || grn "qa token consumed"
date +%s > "$tok"
rm -f "$f"
out=$(W "$BIN" bash "$SD/self-clear.sh" 2>&1); rc=$?
[ $rc = 3 ] && grn "self-clear refuses an UNARMED wtmux pane (3)" || red "unarmed: rc=$rc $out"
out=$(WPANE=2.1 W "$BIN" bash "$SD/self-clear.sh" 2>&1); rc=$?
[ $rc = 4 ] && grn "self-clear refuses a dead wtmux pane (4)" || red "dead pane: rc=$rc $out"
out=$(env -u TMUX -u TMUX_PANE -u WTMUX_PID -u WTMUX_PANE -u KIJITO_AUTOCATCHUP KIJITO_LC_LIB="$LIB" bash "$SD/self-clear.sh" 2>&1); rc=$?
[ $rc = 4 ] && grep -q "not in tmux or wtmux" <<<"$out" && grn "outside any multiplexer self-clear refuses (4)" || red "no-mux self-clear: rc=$rc $out"

# ── 6. the post-/clear resume: SessionStart hook → session-autosend.sh ──────────────────────────
W "$BIN" bash "$SD/arm-session.sh" on >/dev/null 2>&1
: > "$T/wtmux.log"; H="$T/home"; P="$T/proj"; mkdir -p "$H" "$P"
printf '{"source":"clear","cwd":"%s"}' "$P" \
  | W "$BIN" env HOME="$H" CLAUDE_PROJECT_DIR="$P" KIJITO_AUTOCATCHUP_DELAY=0.1 KIJITO_SEND_SETTLE=0.1 \
      bash "$SD/session-catchup-hint.sh" >/dev/null 2>&1
grep -q "autosend=ARMED pane=$ID" "$KIJITO_LC_DIR/lifecycle.log" && grn "SessionStart hook sees the armed wtmux pane and starts autosend" \
  || red "hook: $(grep HOOK "$KIJITO_LC_DIR/lifecycle.log" | tail -1)"
for _ in $(seq 1 20); do grep -q AUTOSEND_FIRE "$KIJITO_LC_DIR/lifecycle.log" 2>/dev/null && break; sleep 0.3; done
if grep -q 'ARGS=send-keys -t 1.1 Run the kijito-start skill' "$T/wtmux.log" && ! grep -q 'send-keys.* -l' "$T/wtmux.log" \
   && grep -qx 'NOPATHCONV=1 EXCL=\* ARGS=send-keys -t 1.1 Enter' "$T/wtmux.log"; then
  grn "autosend typed the catch-up prompt (no -l) and submitted it"
else red "autosend keys: $(cat "$T/wtmux.log")"; fi
grep -q AUTOSEND_FIRE "$KIJITO_LC_DIR/lifecycle.log" && grn "autosend confirmed delivery (prompt tail gone from the screen)" || red "autosend: $(grep AUTOSEND "$KIJITO_LC_DIR/lifecycle.log" | tail -2)"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
