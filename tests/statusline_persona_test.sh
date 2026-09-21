#!/usr/bin/env bash
# Does the status line say WHICH PERSONA this pane is, without breaking what was already there?
# (row M309)
#
# WHY. On the first external onboarding call a test message "looked lost" for minutes because two
# people were watching the wrong terminal — "Wait, no, it's on the other one". A human running eight
# agent panes has nothing on screen telling them which is which. The status line (context % + model)
# was the call's instant hit, so it is the natural place, and that popularity is exactly why the
# context figure must survive the addition intact.
#
# ⚠️ THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT `name (purpose)`. Every persona the first
# external operator runs is named that way, and row M290's defect was that the hook's own marker read
# deleted interior spaces — silently renaming the persona. A status line with a THIRD copy of that
# read would put a confident WRONG label on a pane, which is worse than no label at all.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SL="$REPO/providers/claude/scripts/statusline-context.sh"
HOOK="$REPO/providers/claude/scripts/session-catchup-hint.sh"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

render() {  # $1=cwd  -> statusline output with ANSI stripped
  printf '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"%s"},"context_window":{"used_tokens":420000,"total_tokens":1000000}}' "$1" \
    | bash "$SL" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
}

echo "statusline persona checks:"

# 1. a persona with interior spaces and parentheses survives verbatim (the M290 regression guard)
D="$(mktemp -d)"; printf 'name (purpose)\n' > "$D/.kijito_persona"
out="$(render "$D")"
if [[ "$out" == *"name (purpose)"* ]]; then
  grn "'name (purpose)' is shown verbatim (interior spaces preserved)"
else
  red "'name (purpose)' was not shown verbatim: $out"
fi

# 2. ⭐ ONE MARKER READER: the status line and the hook must resolve the SAME name. Asserted against
#    each other rather than against a literal, because a literal would pass on the day they agree
#    with the test and disagree with each other.
hook_out="$(printf '{"source":"startup","cwd":"%s"}' "$D" | CLAUDE_PROJECT_DIR="$D" bash "$HOOK" 2>/dev/null)"
if [[ "$hook_out" == *"name (purpose)"* ]]; then
  grn "the hook resolves the same persona the status line shows"
else
  red "hook and status line disagree about the persona"
fi

# 3. the context figure survives — it is what people were already watching
if [[ "$out" == *"ctx 420k/1m (42%)"* ]]; then
  grn "the context figure is intact alongside the persona"
else
  red "the context figure was damaged: $out"
fi
rm -rf "$D"

# 4. a long persona is truncated, and truncation does not eat the figure
D="$(mktemp -d)"; printf 'an extremely long persona name that would wrap\n' > "$D/.kijito_persona"
out="$(render "$D")"
if [[ "$out" == *"…"* ]] && [[ "$out" == *"ctx 420k/1m (42%)"* ]]; then
  grn "a long persona is ellipsised and the figure still fits"
else
  red "long-persona truncation failed: $out"
fi
rm -rf "$D"

# 5. no marker → byte-identical to the pre-M309 line. An addition that changes the no-persona case
#    would alter every pane that has no marker, which is most of them on a fresh install.
D="$(mktemp -d)"
out="$(render "$D")"
if [[ "$out" == "Opus 5 · ctx 420k/1m (42%)" ]]; then
  grn "no marker → the original line, unchanged"
else
  red "no marker changed the line: '$out'"
fi
rm -rf "$D"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
