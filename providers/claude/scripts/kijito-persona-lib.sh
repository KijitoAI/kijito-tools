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
    for cand in "$HOME/.kijito-monitor/$safe.jsonl" "$HOME/.cache/kijito-inbox-monitor/events.$safe.ndjson"; do
      [ -e "$cand" ] && { printf '%s' "$cand"; return 0; }
    done
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  cand=$(KJ_WANT="$want" python3 - <<'PYSCAN' 2>/dev/null
import glob, json, os, sys
want = os.environ["KJ_WANT"].casefold(); home = os.path.expanduser("~"); hits = []
for pat in (os.path.join(home, ".kijito-monitor", "*.jsonl"),
            os.path.join(home, ".cache", "kijito-inbox-monitor", "events.*.ndjson")):
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

# kijito_stream_consumed <stream-path> -> 0 if a wake-capable consumer (`tail -n 0 -F …`) reads it.
# ⚠️ ANCHOR ON WHAT THE PROCESS *IS*. An unanchored pgrep on the events path SELF-MATCHES the producer
# (its own argv contains that path), and the harness's `bash -c … eval` wrappers carry the same argv —
# armed-looking and deaf. Only a process whose comm is `tail` counts.
kijito_stream_consumed() {
  local s=${1:-} p
  [ -n "$s" ] || return 1
  for p in $(pgrep -f "tail -n 0 -F.*$(basename "$s")" 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" = tail ] && return 0
  done
  return 1
}
