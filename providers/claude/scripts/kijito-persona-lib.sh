#!/usr/bin/env bash
# ONE place that turns a project directory into a persona NAME. Sourced, never executed.
#
# WHY THIS FILE EXISTS. Row M290 was two defects, and both were copies: the SessionStart hook and the
# producer disagreed about how a persona name becomes a FILENAME, and separately the hook mangled the
# NAME itself before any of that (`tr -d '[:space:]'` deletes interior spaces, so `name (purpose)`
# became `name(purpose)`). The filename half is now owned by the producer and published as
# `kijito-inbox-monitor --safe-persona`. This file owns the other half — reading the marker — so that
# the status line, the hook, and anything added later cannot drift the way those did.
#
# ⛔ THE RULE, AND IT IS THE WHOLE FILE: A MARKER'S PAYLOAD IS ITS FIRST LINE WITH THE ENDS TRIMMED.
# Anything stricter silently RENAMES the user's persona, and the rename is invisible — it surfaces
# later as "your mail is not being collected", pointing at a file nobody writes.

# kijito_persona_from_marker [dir ...] -> prints the persona, or nothing.
# Searches the given directories in order; defaults to $CLAUDE_PROJECT_DIR then $PWD.
kijito_persona_from_marker() {
  local d p
  if [ "$#" -eq 0 ]; then set -- "${CLAUDE_PROJECT_DIR:-}" "$PWD"; fi
  for d in "$@"; do
    [ -n "$d" ] || continue
    [ -f "$d/.kijito_persona" ] || continue
    # first line, CR/LF stripped — NOT all whitespace (see the rule above)
    p=$(head -n1 "$d/.kijito_persona" 2>/dev/null | tr -d '\r\n')
    p="${p#"${p%%[![:space:]]*}"}"   # leading blanks
    p="${p%"${p##*[![:space:]]}"}"   # trailing blanks
    if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# kijito_truncate <string> <max> -> prints the string, ellipsised if longer than max.
# A status line shares a terminal with everything else, so a long persona must not push the context
# figure off the edge — the figure is the thing the user was watching before the persona existed.
kijito_truncate() {
  local s=$1 max=$2
  if [ "${#s}" -le "$max" ]; then printf '%s' "$s"; return 0; fi
  [ "$max" -le 1 ] && { printf '%s' "${s:0:$max}"; return 0; }
  printf '%s…' "${s:0:$((max-1))}"
}

# kijito_stream_for_persona <persona> -> prints the producer's event-stream path for it, or nothing.
# TWO NON-GUESSING ROUTES, in order (moved here from inbox-selftest.sh for row M291, so the heartbeat
# watchdog and the self-test cannot drift — the M290 lesson):
#   1. ask the producer: `kijito-inbox-monitor --safe-persona` publishes the persona->filename rule;
#   2. read the streams: the producer stamps every event with the persona it was written for, so the
#      file itself says whose mail it holds — works on a seat whose producer predates --safe-persona.
kijito_stream_for_persona() {
  local want=${1:-} km="" c safe="" cand
  [ -n "$want" ] || return 1
  for c in "${KIJITOMON_BIN:-}" "$(command -v kijito-inbox-monitor 2>/dev/null)" \
           "$HOME/.local/bin/kijito-inbox-monitor" "/usr/local/bin/kijito-inbox-monitor"; do
    if [ -n "$c" ] && [ -x "$c" ]; then km=$c; break; fi
  done
  [ -n "$km" ] && safe=$("$km" --safe-persona "$want" 2>/dev/null)
  if [ -n "$safe" ]; then
    # THREE layouts: the fleet's systemd units, the launchd plist, and the monitor's own shipped systemd
    # template (~/.local/state, XDG state) - the last one was missing until row M313's follow-up, so a
    # Linux user who installed the unit from the monitor repo had a stream nothing here would find.
    for cand in "$HOME/.kijito-monitor/$safe.jsonl" "$HOME/.cache/kijito-inbox-monitor/events.$safe.ndjson" \
                "$HOME/.local/state/kijito-inbox-monitor/events.$safe.ndjson"; do
      [ -e "$cand" ] && { printf '%s' "$cand"; return 0; }
    done
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  cand=$(KJ_WANT="$want" python3 - <<'PYSCAN' 2>/dev/null
import glob, json, os, sys
want = os.environ["KJ_WANT"].casefold(); home = os.path.expanduser("~"); hits = []
for pat in (os.path.join(home, ".kijito-monitor", "*.jsonl"),
            os.path.join(home, ".cache", "kijito-inbox-monitor", "events.*.ndjson"),
            os.path.join(home, ".local", "state", "kijito-inbox-monitor", "events.*.ndjson")):
    for path in glob.glob(pat):
        try:
            with open(path, "rb") as fh:
                who = json.loads(fh.readline(65536)).get("persona")
        except Exception:
            continue
        if isinstance(who, str) and who.casefold() == want:
            hits.append(path)
if len(hits) == 1:
    sys.stdout.write(hits[0])
PYSCAN
)
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  return 1
}

# kijito_unread_for_persona <persona> -> prints the persona's unread count, or nothing (row M309).
# The producer (kijito-inbox-monitor >= 0.5.7) writes `unread` into the persona's STATE file on every poll
# that had a count, and omits it when it had none. Nothing is printed unless a FRESH state file for this
# persona holds one: a stale or missing figure is a confident wrong number on a pane, which is worse than none.
# ⛔ THE FILE IS FOUND BY WHAT IT SAYS, NOT BY ITS NAME. Re-deriving the persona->filename rule here would be a
# third copy of it (the M290 lesson); every state file records its own watched persona in `identity`, so one
# jq pass over the known layouts asks the files instead. Newest first, and the NEWEST match decides: if it
# holds no count (unknown), an older file's figure must not stand in for it.
kijito_unread_for_persona() {
  local want=${1:-} f n files=()
  [ -n "$want" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # rewritten every poll, so anything older than 10 min is a producer that has stopped writing it
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(
    find "$HOME/.kijito-monitor" "$HOME/.cache/kijito-inbox-monitor" "$HOME/.local/state/kijito-inbox-monitor" \
         -maxdepth 1 -type f \( -name '*.state' -o -name 'hive.*.json' -o -name 'state.*.json' \) -mmin -10 \
         2>/dev/null)
  [ "${#files[@]}" -gt 0 ] || return 1
  # shellcheck disable=SC2012  # the paths come from find above; ls is only ordering them by mtime
  n=$(ls -t "${files[@]}" 2>/dev/null | tr '\n' '\0' | xargs -0 jq -rn --arg w "$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" '
        first(inputs | select((try (.identity[4] | map(select(.[0] == "persona")) | .[0][1] | ascii_downcase)
                               catch null) == $w)) | .unread // empty' 2>/dev/null)
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$n"
}

# ── NATIVE WINDOWS (Git Bash / MSYS / Cygwin). Reported by praetor on a real Windows 11 seat: Git Bash
# has no `pgrep`, and MSYS `ps` cannot see native Windows processes at all, so every process probe below
# answered "not running" — the hook said "producer: DOWN" beside a producer that was delivering mail, and
# suggested launchctl/systemctl, neither of which exists there. ⛔ THE FIX IS A THIRD ANSWER, NOT A
# GUESS: when a host gives us no way to look, the probes return 2 = COULD NOT MEASURE, and callers must
# say so instead of reporting DOWN. On Windows we ask the OS itself (Win32_Process via PowerShell).
kijito_host_is_windows() {
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  return 1
}

# _kijito_win_count <Where-Object filter> -> prints how many native Windows processes match; returns 2
# (and prints nothing) when PowerShell is absent or its answer is not a number.
# ⛔ THE FILTER IS CODE: never interpolate a caller-supplied value into it (river's 0.2.11 review, MEDIUM-2:
# a persona from a cloned repo's .kijito_persona reached `-like '*--persona $p*'`, so `x' -or (iwr …|iex)
# -or 'y` ran inside Where-Object). Pass the value in $KIJITO_PS_ARG and read it as $env:KIJITO_PS_ARG -
# PowerShell then treats it as data, and [regex]::Escape / .Contains keep it literal.
_kijito_win_count() {
  local psh n
  psh=$(command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null \
        || command -v pwsh 2>/dev/null) || return 2
  n=$("$psh" -NoProfile -NonInteractive -Command \
      "@(Get-CimInstance Win32_Process | Where-Object { $1 }).Count" 2>/dev/null | tr -d '\r[:space:]')
  case "$n" in ''|*[!0-9]*) return 2 ;; esac
  printf '%s' "$n"
}

# kijito_producer_running -> 0 a producer process is running on this host, 1 none is, 2 COULD NOT MEASURE.
# ⚠️ The pattern must not match a CONSUMER: a tail's own argv can contain "kijito-inbox-monitor" (the
# macOS stream path does), so anchor on how the EXECUTABLE appears, and on Windows also exclude the
# shells and tools whose command lines merely mention it (including the PowerShell asking the question).
kijito_producer_running() {
  local n
  if kijito_host_is_windows; then
    n=$(_kijito_win_count '$_.CommandLine -match "kijito_inbox_monitor\.py|kijito-inbox-monitor\.exe|bin[\\/]kijito-inbox-monitor" -and @("tail.exe","grep.exe","bash.exe","sh.exe","powershell.exe","pwsh.exe") -notcontains $_.Name') || return 2
    [ "$n" -gt 0 ] && return 0
    return 1
  fi
  command -v pgrep >/dev/null 2>&1 || return 2
  pgrep -f "kijito_inbox_monitor\.py|bin/kijito-inbox-monitor" >/dev/null 2>&1 && return 0
  pgrep -f "kijito-inbox-monitor .*--persona" >/dev/null 2>&1 && return 0
  return 1
}

# kijito_restart_hint <launchd|systemd|task> [persona] -> the command that (re)starts a producer there.
kijito_restart_hint() {
  case "${1:-}" in
    launchd) printf 'launchctl kickstart -k gui/$(id -u)/com.kijito.inbox-monitor' ;;
    # Windows: MANUAL start first. Jason's ruling (2026-09-27, relayed by crucible): "Ideally in both
    # places I want monitor start to be manual, these are gaming comps after all." A Scheduled Task is
    # the opt-in autostart, never the default suggestion.
    task)    printf 'start it by hand from a normal (non-sandboxed) shell: kijito-inbox-monitor --persona %s  (or your supervisor script); if you opted into autostart, run its Scheduled Task instead: schtasks /Run /TN "<task name>"' "${2:-<persona>}" ;;
    # No supervisor on this host: the one-command start (it starts a producer and proves it with a message).
    manual)  printf '~/.claude/kijito-inbox-start.sh --persona %s  (starts a producer by hand; it stops at logout/reboot - see the monitor README for supervision)' "${2:-<persona>}" ;;
    *)       printf 'systemctl --user enable --now kijito-inbox-monitor@%s' "${2:-<persona>}" ;;
  esac
}

# kijito_producer_covers <persona> [stream-path] -> 0 a RUNNING producer covers this persona, 1 none does,
# 2 COULD NOT MEASURE. Evidence comes only from a live process's own argv - any one of: the resolved stream
# path verbatim (systemd's --events-file), `--persona <p>` as a whole argument (a per-persona unit), or
# `--all-personas` (one producer for every persona; launchd passes a TEMPLATE, not the path).
# ⛔ A STREAM FILE IS NOT A PRODUCER. kijito-inbox-start.sh used "written in the last 10 min" as proof, so a
# producer that had just died blocked its own restart for 10 minutes (river 10985, M312 cold rerun); the
# hook learned the same rule the hard way (assay cert F1). ⛔ And a process that merely MENTIONS the
# producer (a grep, a checker shell) is not the producer: only a python process or the console script.
kijito_producer_covers() {
  local p=${1:-} ev=${2:-} line n
  [ -n "$p" ] || return 1
  if kijito_host_is_windows; then
    # --persona as a WHOLE argument (LOW-3: '*--persona river*' also matched 'riverbank'), optionally quoted.
    n=$(KIJITO_PS_ARG="$p" _kijito_win_count "\$_.CommandLine -match 'kijito_inbox_monitor\.py|kijito-inbox-monitor\.exe|bin[\\/]kijito-inbox-monitor' -and @('tail.exe','grep.exe','bash.exe','sh.exe','powershell.exe','pwsh.exe') -notcontains \$_.Name -and (\$_.CommandLine -match ('--persona[\s=]+\"?' + [regex]::Escape(\$env:KIJITO_PS_ARG) + '\"?(\s|\$)') -or \$_.CommandLine -like '*--all-personas*')") || return 2
    [ "$n" -gt 0 ] && return 0
    return 1
  fi
  command -v pgrep >/dev/null 2>&1 || return 2
  # ⚠️ NOT `pgrep -af`: macOS pgrep has no -a (usage `pgrep [-Lfilnoqvx]`), so it printed nothing and
  # every Mac answered "not covered" - inbox-start then started a DUPLICATE producer on each run. Take the
  # pids from `pgrep -f` and read each argv with `ps -o command=`, which both platforms support.
  local pid
  while IFS= read -r line; do
    case "$line" in *[Pp]ython*|*/kijito-inbox-monitor\ *|*/kijito-inbox-monitor) ;; *) continue ;; esac
    case "$line" in *" grep "*|*session-catchup-hint*|*kijito-inbox-start*) continue ;; esac
    # whole-argument match: "--persona river" must not match "--persona riverbank"
    case "$line " in *" --persona $p "*|*" --persona=$p "*|*" --all-personas "*) return 0 ;; esac
    [ -n "$ev" ] && case "$line " in *" $ev "*) return 0 ;; esac
    # A producer started with NO --persona watches every persona IN ITS ACCOUNT (the launchd job passes
    # only --events-file-template). Its argv cannot say which account, so it covers THIS persona only when
    # this persona's stream lives where it writes: the stream's directory is in its argv. Without that
    # constraint a seat's fleet producer "covered" any name at all, and inbox-start skipped starting one.
    if [ -n "$ev" ]; then
      case "$line " in *" --persona "*|*" --persona="*) ;; *" $(dirname "$ev")/"*) return 0 ;; esac
    fi
  done < <(for pid in $(pgrep -f "kijito[-_]inbox[-_]monitor" 2>/dev/null); do
             line=$(ps -o command= -p "$pid" 2>/dev/null) && [ -n "$line" ] && printf '%s %s\n' "$pid" "$line"
           done)
  return 1
}

# kijito_supervisor_for <persona> -> prints task | systemd | launchd | manual: the supervisor that is
# ACTUALLY present for the inbox producer on this host.
# ⚠️ WHY (river 10985, M312 cold rerun): the hook guessed the supervisor from which stream PATH existed,
# so a producer started by hand on a box with no systemd was reported "UP (systemd)" and offered a
# systemctl restart line that could not work; the self-test offered launchctl on Linux. The question is
# not "which layout is this file in" but "what would restart it here", and only the supervisors can say.
kijito_supervisor_for() {
  local p=${1:-}
  if kijito_host_is_windows; then echo task; return 0; fi
  # systemd: a kijito-inbox-monitor USER unit (per-persona instance or the template) is installed. A box
  # with no systemd, or no user bus (containers), answers nothing here and falls through.
  if command -v systemctl >/dev/null 2>&1 \
     && [ -n "$(systemctl --user list-unit-files 'kijito-inbox-monitor*' --no-legend 2>/dev/null)" ]; then
    echo systemd; return 0
  fi
  if [ "$(uname -s 2>/dev/null)" = Darwin ] \
     && { [ -f "$HOME/Library/LaunchAgents/com.kijito.inbox-monitor.plist" ] \
          || launchctl list com.kijito.inbox-monitor >/dev/null 2>&1; }; then
    echo launchd; return 0
  fi
  echo manual
}

# kijito_stream_consumed <stream-path> -> 0 if a wake-capable consumer (`tail -n 0 -F …`) reads it,
# 1 if none does, 2 COULD NOT MEASURE (no way to list processes on this host). `if kijito_stream_consumed`
# treats 2 as "not consumed", exactly as before; callers that can say "unknown" should test for 2.
# ⚠️ ANCHOR ON WHAT THE PROCESS *IS*. An unanchored pgrep on the events path SELF-MATCHES the producer
# (its own argv contains that path), and the harness's `bash -c … eval` wrappers carry the same argv —
# armed-looking and deaf. Only a process whose comm is `tail` counts.
kijito_stream_consumed() {
  local s=${1:-} p b n
  [ -n "$s" ] || return 1
  b=$(basename "$s")
  if kijito_host_is_windows; then
    # Only tail.exe counts (the same anchor as below); its command line must carry the follow flags and
    # this stream's basename. A basename is a literal, so match it with -like, never as a regex.
    n=$(KIJITO_PS_ARG="$b" _kijito_win_count "\$_.Name -eq 'tail.exe' -and \$_.CommandLine -match '-n\s+0\s+-F' -and \$_.CommandLine.Contains(\$env:KIJITO_PS_ARG)") || return 2
    [ "$n" -gt 0 ] && return 0
    return 1
  fi
  command -v pgrep >/dev/null 2>&1 || return 2
  for p in $(pgrep -f "tail -n 0 -F.*$b" 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = tail ] && return 0
  done
  return 1
}

# _kijito_etime_secs <[[dd-]hh:]mm:ss> -> seconds. `ps -o etime=` is the one age column Linux and
# macOS both have (macOS ps has no `etimes`).
_kijito_etime_secs() {
  local t=${1//[[:space:]]/} d=0 h=0 m=0 s=0
  case "$t" in *-*) d=${t%%-*}; t=${t#*-} ;; esac
  IFS=: read -r a b c <<<"$t"
  if [ -n "${c:-}" ]; then h=$a; m=$b; s=$c; else m=$a; s=${b:-0}; fi
  echo $(( 10#$d*86400 + 10#$h*3600 + 10#$m*60 + 10#$s ))
}

# kijito_stream_consumers <stream-path> -> prints one "<pid> <age-seconds>" line per wake-capable
# consumer (same anchor as kijito_stream_consumed: only a real `tail` counts). Returns 0 if any, 1 if
# none, 2 COULD NOT MEASURE.
# ⚠️ WHY THE AGE: a consumer's EXISTENCE does not prove it can wake anyone. The Claude Code Monitor
# tool caps a watch at 30 min on many sessions, and on Windows/Git Bash an expired Monitor LEAKS its
# tail (crucible measured 65 live orphans on one seat, [35702]) — so "a tail exists" read as "armed"
# forever. Callers compare the age with that cap; they cannot know ownership, so they report, not kill.
kijito_stream_consumers() {
  local s=${1:-} p b psh out e found=1
  [ -n "$s" ] || return 1
  b=$(basename "$s")
  if kijito_host_is_windows; then
    psh=$(command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null \
          || command -v pwsh 2>/dev/null) || return 2
    out=$(KIJITO_PS_ARG="$b" "$psh" -NoProfile -NonInteractive -Command \
      "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'tail.exe' -and \$_.CommandLine -match '-n\s+0\s+-F' -and \$_.CommandLine.Contains(\$env:KIJITO_PS_ARG) } | ForEach-Object { '{0} {1}' -f \$_.ProcessId, [int]((Get-Date) - \$_.CreationDate).TotalSeconds }" \
      2>/dev/null | tr -d '\r') || return 2
    while read -r p e; do
      case "$p" in ''|*[!0-9]*) continue ;; esac
      case "$e" in ''|*[!0-9]*) continue ;; esac
      echo "$p $e"; found=0
    done <<<"$out"
    return $found
  fi
  command -v pgrep >/dev/null 2>&1 || return 2
  for p in $(pgrep -f "tail -n 0 -F.*$b" 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = tail ] || continue
    e=$(ps -o etime= -p "$p" 2>/dev/null) || continue
    echo "$p $(_kijito_etime_secs "$e")"; found=0
  done
  return $found
}
