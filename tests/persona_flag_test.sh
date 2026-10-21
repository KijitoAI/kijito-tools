#!/usr/bin/env bash
# Does `install.sh --persona <name>` write the folder's persona marker, and does an install with no
# persona skip the inbox check instead of reporting it as a failure?
#
# WHY THIS EXISTS (row N43, M312 cold run #11, River/plans/m312-runs/2026-10-21r11-claude-code-opus-prod.md).
# The installer looked for .kijito_persona before the agent had written it and printed
# "COULD NOT MEASURE: no persona … The inbox is NOT set up yet"; then the agent's own write of the
# marker was refused by its client, and the human had to run a printf by hand. The human had already
# said yes to the installer, so the installer now writes the marker itself. This runs the REAL
# installer end to end against a throwaway HOME and project folder.
#
#   bash tests/persona_flag_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${KIJITO_TEST_INSTALLER:-$REPO/install.sh}"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the installer requires it."; exit 0; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
# run <name> [installer args...] — fresh HOME + project folder per case; prints output, sets $rc, $h, $p.
run() {
  local n=$1; shift
  h="$T/$n/home"; p="$T/$n/project"; mkdir -p "$h" "$p"
  out=$( ( cd "$p" && env -u KIJITO_API_TOKEN -u CLAUDE_PROJECT_DIR -u SELFTEST_PERSONA HOME="$h" \
           bash "$INSTALLER" --allow-branch "$@" 2>&1 ) ); rc=$?
}

echo "--persona writes the marker:"
run named --persona coldrun
if [ "$rc" = 0 ] && [ "$(cat "$p/.kijito_persona" 2>/dev/null)" = coldrun ]; then grn "--persona coldrun → .kijito_persona holds exactly 'coldrun'"
else red "marker not written as 'coldrun' (rc=$rc, file='$(cat "$p/.kijito_persona" 2>/dev/null)')"; fi
grep -q "persona 'coldrun' set for this folder" <<<"$out" && grn "the write is announced" || red "no announcement of the marker write"
[ -x "$h/.claude/myctx.sh" ] && grn "the toolkit was installed as usual" || red "the toolkit was not installed"
# A persona whose inbox was never set up (no event stream on this machine) is the NORMAL state on a
# first install: the inbox is a later step. Before this fix it ran the self-test, printed "THE INBOX
# WAKE PATH IS BROKEN" and exited 1.
if grep -qE 'IS BROKEN|COULD NOT MEASURE|NOT WORKING' <<<"$out"; then red "a never-set-up inbox is reported as a failure: $(grep -E 'IS BROKEN|COULD NOT MEASURE|NOT WORKING' <<<"$out" | head -1)"
else grn "a never-set-up inbox is not reported as broken"; fi
grep -q "Inbox not set up yet for 'coldrun'" <<<"$out" && grep -q 'messages to it will NOT reach your agent' <<<"$out" \
  && grep -q 'kijito-inbox-start.sh --persona coldrun' <<<"$out" \
  && grn "says the inbox is not set up, that mail will not arrive, and the exact command, with the persona filled in" \
  || red "not-set-up copy missing: $(grep -iA4 'inbox wake path' <<<"$out" | tail -4)"

# An inbox that DOES exist for the persona (its event stream is on disk) is still checked for real.
h="$T/exists/home"; p="$T/exists/project"; mkdir -p "$h/.cache/kijito-inbox-monitor" "$p"
printf '{"event": "heartbeat", "persona": "coldrun"}\n' > "$h/.cache/kijito-inbox-monitor/events.coldrun.ndjson"
out=$( ( cd "$p" && env -u KIJITO_API_TOKEN -u CLAUDE_PROJECT_DIR -u SELFTEST_PERSONA HOME="$h" \
         bash "$INSTALLER" --allow-branch --persona coldrun 2>&1 ) )
grep -q 'kijito inbox self-test \[persona=coldrun\]' <<<"$out" && grn "an existing inbox for the persona is still self-tested" \
  || red "existing inbox not self-tested: $(grep -iA3 'inbox wake path' <<<"$out" | tail -3)"

run eqform "--persona=  spaced name  "
[ "$(cat "$p/.kijito_persona" 2>/dev/null)" = "spaced name" ] && grn "--persona=… form, ends trimmed, interior space kept" \
  || red "--persona= form wrote '$(cat "$p/.kijito_persona" 2>/dev/null)'"

echo "no persona: the inbox check is skipped, not failed:"
run none
[ "$rc" = 0 ] && grn "exit 0" || red "exit $rc"
[ ! -e "$p/.kijito_persona" ] && grn "no marker is invented" || red "a marker was written without --persona"
grep -q 'Inbox check skipped: no persona is set for this folder yet' <<<"$out" && grn "says the check was skipped, and why" \
  || red "no skip line: $(grep -iA3 'inbox wake path' <<<"$out" | tail -3)"
grep -q 'kijito-inbox-start.sh --persona <name>' <<<"$out" && grn "names the command that sets the inbox up (M383)" || red "the next step is not named"
if grep -qE 'COULD NOT MEASURE|NOT set up yet' <<<"$out"; then red "still prints the alarming copy: $(grep -E 'COULD NOT MEASURE|NOT set up yet' <<<"$out")"
else grn "no 'COULD NOT MEASURE' / 'NOT set up yet' at install time"; fi

echo "an existing marker is respected:"
run same --persona coldrun; run same --persona coldrun
[ "$rc" = 0 ] && grep -q "persona 'coldrun' was already set" <<<"$out" && grn "same name again → accepted, nothing rewritten" \
  || red "re-run with the same persona: rc=$rc $(grep -i persona <<<"$out" | head -2)"
h="$T/other/home"; p="$T/other/project"; mkdir -p "$h" "$p"; printf 'alice\n' > "$p/.kijito_persona"
out=$( ( cd "$p" && env -u KIJITO_API_TOKEN -u CLAUDE_PROJECT_DIR HOME="$h" bash "$INSTALLER" --allow-branch --persona bob 2>&1 ) ); rc=$?
[ "$rc" = 2 ] && grn "a marker naming someone else → refused (exit 2)" || red "conflicting marker: rc=$rc"
[ "$(cat "$p/.kijito_persona")" = alice ] && grn "the existing marker is left unchanged" || red "the marker was overwritten"
grep -q "already names the persona 'alice', not 'bob'" <<<"$out" && grn "the refusal names both personas" || red "refusal text: $out"
[ ! -e "$h/.claude/myctx.sh" ] && grn "nothing was installed on refusal" || red "installed despite refusing"

echo "bad names are refused before anything is installed:"
for bad in "" "   " "--allow-branch"; do
  run "bad$RANDOM" --persona "$bad"
  if [ "$rc" = 2 ] && [ ! -e "$p/.kijito_persona" ] && [ ! -e "$h/.claude/myctx.sh" ]; then grn "--persona '$bad' → exit 2, no marker, nothing installed"
  else red "--persona '$bad': rc=$rc marker=$( [ -e "$p/.kijito_persona" ] && echo yes || echo no)"; fi
done
run noval --persona
[ "$rc" = 2 ] && [ ! -e "$h/.claude/myctx.sh" ] && grn "--persona with no value → exit 2, nothing installed" || red "--persona alone: rc=$rc"
run nl --persona "$(printf 'two\nlines')"
[ "$rc" = 2 ] && [ ! -e "$p/.kijito_persona" ] && grn "a two-line name → refused" || red "two-line name: rc=$rc"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
