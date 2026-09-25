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
    | env -u TMUX_PANE bash "$SL" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
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
# ⛔ NEVER WITH THE CALLER'S TMUX PANE: on an ARMED pane the hook autosends the catch-up prompt into
# it, so running this suite from an agent's own pane typed a boot prompt into that agent once per run.
hook_out="$(printf '{"source":"startup","cwd":"%s"}' "$D" \
  | env -u TMUX -u TMUX_PANE -u KIJITO_AUTOCATCHUP CLAUDE_PROJECT_DIR="$D" bash "$HOOK" 2>/dev/null)"
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

# ── row M309, second half: the unread count, read from the producer's STATE file ───────────────────
# Every case runs under a scratch HOME, so the seat's real state files can never make a case pass.
echo "statusline unread-count checks:"
H="$(mktemp -d)"; D="$(mktemp -d)"; printf 'argus\n' > "$D/.kijito_persona"
mkdir -p "$H/.kijito-monitor" "$H/.cache/kijito-inbox-monitor"
state() {  # $1=path $2=persona $3=unread-json-fragment ("" = no field)
  printf '{"identity":["https","api.kijito.ai",443,"/api/inbox",[["persona","%s"]]],"cursor":1,"state":"UP","consecutive_failures":0%s}' \
    "$2" "${3:+,\"unread\":$3}" > "$1"
}
hrender() { HOME="$H" render "$D"; }

state "$H/.kijito-monitor/argus.state" argus 4
out="$(hrender)"
if [[ "$out" == "argus · ✉ 4 · Opus 5 · ctx 420k/1m (42%)" ]]; then
  grn "a fresh state file's count is shown after the persona"
else
  red "count not shown as expected: '$out'"
fi

state "$H/.kijito-monitor/argus.state" argus 0
out="$(hrender)"
if [[ "$out" == "argus · Opus 5 · ctx 420k/1m (42%)" ]]; then
  grn "zero unread → the line is unchanged"
else
  red "zero unread changed the line: '$out'"
fi

state "$H/.kijito-monitor/argus.state" argus 4
touch -t 202001010000 "$H/.kijito-monitor/argus.state"
out="$(hrender)"
if [[ "$out" != *"✉"* ]]; then
  grn "a STALE state file (producer stopped writing) shows no count"
else
  red "a stale count was shown: '$out'"
fi

rm -f "$H/.kijito-monitor/argus.state"
state "$H/.kijito-monitor/river.state" river 9
out="$(hrender)"
if [[ "$out" != *"✉"* ]]; then
  grn "another persona's state file is never read as this pane's"
else
  red "a sibling's count leaked onto this pane: '$out'"
fi

# the NEWEST file for this persona decides; its "unknown" must not be filled from an older file
state "$H/.cache/kijito-inbox-monitor/hive.argus.json" argus 6
touch -t "$(date -d '-5 min' +%Y%m%d%H%M 2>/dev/null || date -v-5M +%Y%m%d%H%M)" "$H/.cache/kijito-inbox-monitor/hive.argus.json"
state "$H/.kijito-monitor/argus.state" argus ""
out="$(hrender)"
if [[ "$out" != *"✉"* ]]; then
  grn "the newest state file's UNKNOWN is not replaced by an older file's figure"
else
  red "an older file's count stood in for an unknown: '$out'"
fi
rm -f "$H/.kijito-monitor/argus.state"
out="$(hrender)"
if [[ "$out" == *"✉ 6"* ]]; then
  grn "the launchd layout (hive.<persona>.json) is found too"
else
  red "the launchd-layout count was not found: '$out'"
fi

# the marker's spelling and the URL's may differ in case; the file still says whose it is
printf 'Argus\n' > "$D/.kijito_persona"
out="$(hrender)"
if [[ "$out" == *"✉ 6"* ]]; then
  grn "the persona is matched case-insensitively"
else
  red "case-variant persona missed its count: '$out'"
fi
rm -rf "$H" "$D"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
