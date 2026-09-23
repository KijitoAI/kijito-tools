#!/usr/bin/env bash
# Claude Code statusline — model name + accurate context-window usage.
# Source of truth, in order:
#   1) harness-provided context_window.* fields (if this CC version supplies them)
#   2) fallback: compute from the transcript's API usage ledger — the same data
#      /context is built on (sum input+cache_read+cache_creation of last asst turn).
# Reads the statusline JSON on stdin; prints one line. ~tens of ms; never enters the model's context.
input=$(cat)

model=$(printf '%s' "$input" | jq -r '.model.display_name // "Claude"')

# ── WHICH PANE AM I? (row M309) ──────────────────────────────────────────────────────────────────
# On the first external onboarding call a test message "looked lost" for several minutes because two
# people were watching the wrong terminal — "Wait, no, it's on the other one … it would be here
# because this is the fable". A human running eight agent panes has NOTHING on screen saying which
# persona each one is; the status line was the call's instant hit, so it is where that belongs.
#
# ⛔ THE MARKER IS READ THROUGH THE SHARED HELPER, NEVER RE-PARSED HERE. Re-implementing it is exactly
# how row M290 happened: the hook's own copy deleted interior spaces, so `name (purpose)` silently
# became a different persona. A third copy in the status line would drift the same way, and here it
# would be worse — a status line that says the WRONG persona is a confident label on the wrong pane,
# which is the very confusion this row exists to end.
_sl_dir="$(dirname -- "${BASH_SOURCE[0]:-$0}")"
persona=""
if [ -r "$_sl_dir/kijito-persona-lib.sh" ]; then
  # shellcheck source=/dev/null
  . "$_sl_dir/kijito-persona-lib.sh"
  # The statusline JSON carries the pane's cwd; prefer it over $PWD, which is this script's.
  _sl_cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')
  persona=$(kijito_persona_from_marker "${CLAUDE_PROJECT_DIR:-}" "$_sl_cwd" "$PWD" || true)
fi

# 1) Prefer harness-computed context window if present
used=$(printf '%s' "$input" | jq -r '.context_window.used_tokens // empty')
win=$(printf '%s'  "$input" | jq -r '.context_window.total_tokens // empty')

# 2) Fallback: ground-truth from the transcript usage ledger
if [ -z "$used" ]; then
  tp=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    used=$(jq -s 'map(select(.type=="assistant" and .message.usage != null) | .message.usage) | last // {}
                  | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)' \
          "$tp" 2>/dev/null)
  fi
fi
[ -z "$used" ] && used=0
[ -z "$win"  ] && win=1000000

pct=$(awk -v u="$used" -v w="$win" 'BEGIN { if (w>0) printf "%.0f", (u/w)*100; else print 0 }')
uk=$(awk  -v u="$used" 'BEGIN { if (u>=1000) printf "%.0fk", u/1000; else printf "%d", u }')
wk=$(awk  -v w="$win"  'BEGIN { if (w>=1000000) printf "%gm", w/1000000; else printf "%.0fk", w/1000 }')

# refresh-before-70 discipline: green <60, yellow 60-79, red >=80
col=$(awk -v p="$pct" 'BEGIN { if (p>=80) printf "\033[31m"; else if (p>=60) printf "\033[33m"; else printf "\033[32m" }')
# ⚠️ THE PERSONA GOES FIRST AND IS TRUNCATED, NOT THE CONTEXT FIGURE. The figure is what people were
# already watching; a long persona must never push it off a narrow terminal. 18 chars fits
# "name (purpose)"-shaped names, which is what real users type.
if [ -n "$persona" ]; then
  printf '\033[36m%s\033[0m · ' "$(kijito_truncate "$persona" 18)"
fi
printf '%s · ctx %b%s/%s (%s%%)\033[0m' "$model" "$col" "$uk" "$wk" "$pct"
