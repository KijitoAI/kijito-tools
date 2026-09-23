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
