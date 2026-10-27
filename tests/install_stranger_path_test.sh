#!/usr/bin/env bash
# Does the installer tell a NEW USER only true things, and only offer the autonomy doctrine?
#
# WHY THIS EXISTS. Two installer outputs a first-time user must never see:
#   - "it holds a bearer token" printed over a settings.json whose env holds nothing but
#     KIJITO_AUTOCATCHUP_DELAY. A claim about a secret that is not there teaches the reader to
#     skim past the one that is.
#   - an ending of "Next: add the doctrine snippet", which pushes the autonomy doctrine (self-clear,
#     armed panes) at someone who asked for memory — it "goes further than what you agreed to".
# Both are properties of the installer's OUTPUT, so this runs the REAL installer end to end against a
# throwaway HOME and reads what it printed.
#
#   bash tests/install_stranger_path_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${KIJITO_TEST_INSTALLER:-$REPO/install.sh}"
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed — the installer requires it."; exit 0; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT INT TERM
# One install into a fresh HOME whose settings.json already exists at 0644 with the given env block.
# --allow-branch: install exactly this checkout's bytes (see install_mode_test.sh). The trailing inbox
# self-test finds no persona or token here and says COULD NOT MEASURE; that is not what this file tests.
install_with_env() {  # $1 = name, $2 = env JSON object
  local h="$T/$1"; mkdir -p "$h/.claude"
  printf '{"env": %s}\n' "$2" > "$h/.claude/settings.json"; chmod 0644 "$h/.claude/settings.json"
  ( umask 002; cd "$h" && env -u KIJITO_API_TOKEN HOME="$h" bash "$INSTALLER" --allow-branch 2>&1 )
}

echo "installer output on the first-time install path:"
# ── the credential claim, both branches ──────────────────────────────────────────────────────────
out=$(install_with_env notoken '{"KIJITO_AUTOCATCHUP_DELAY": "4.0"}')
if grep -q 'tightened settings.json 644 → 600' <<<"$out"; then grn "a 0644 settings.json is tightened, and the tighten is announced"
else red "no tighten line for a 0644 settings.json: $(grep -i tighten <<<"$out")"; fi
if grep -qiE 'holds a (bearer token|credential)' <<<"$out"; then red "claims a credential that is not there: $(grep -iE 'holds a' <<<"$out")"
else grn "no credential in env → no claim that it holds one"; fi

out=$(install_with_env token '{"KIJITO_API_TOKEN": "kjt_SECRETVALUE123", "KIJITO_AUTOCATCHUP_DELAY": "4.0"}')
if grep -q 'holds a credential: KIJITO_API_TOKEN' <<<"$out"; then grn "a token in env is named by its KEY"
else red "token present but not named: $(grep -i tighten <<<"$out")"; fi
if grep -q 'SECRETVALUE' <<<"$out"; then red "the installer printed a credential VALUE"; else grn "the credential's value is never printed"; fi

# ── an installer that could not prove the wake names the one command that does ───────────────────
# (With no persona the check is SKIPPED, not reported as COULD NOT MEASURE, but it must still name the
# command that sets the inbox up and say it is not set up.)
if grep -q 'kijito-inbox-start.sh --persona <name>' <<<"$out" && grep -q 'Inbox check skipped: no persona is set' <<<"$out"; then
  grn "no persona yet: the installer ends by naming the start-and-prove command"
else red "the installer does not name the start-and-prove step: $(grep -iA3 'wake path\|inbox' <<<"$out" | tail -5)"; fi

# ── the autonomy doctrine is offered, not pushed ─────────────────────────────────────────────────
if grep -q 'Next: add the doctrine snippet' <<<"$out"; then red "still instructs a new user to add the autonomy doctrine"
else grn "no instruction to add the autonomy doctrine"; fi
if grep -q 'Optional — only if you want it' <<<"$out" && grep -q 'add it to ~/.claude/CLAUDE.md only if you want that' <<<"$out" \
   && grep -q 'self-clear loop that lets an agent clear its own context' <<<"$out"; then
  grn "the doctrine is an opt-in that says, in plain words, what it would change"
else red "the opt-in consent text is missing or incomplete: $(grep -iA4 'doctrine\|snippet' <<<"$out" | head -6)"; fi
# The tmux note prints only when tmux is ABSENT, and CI and the machines have it - so hide it: a private PATH
# mirroring every tool except tmux (the same trick windows_detect_test.sh uses for PowerShell).
NOTMUX="$T/notmux"; mkdir -p "$NOTMUX"
( IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do n=${f##*/}
    [ "$n" = tmux ] && continue; [ -x "$f" ] && [ ! -e "$NOTMUX/$n" ] && ln -s "$f" "$NOTMUX/$n"; done; done )
h="$T/notmuxhome"; mkdir -p "$h"
out=$( ( cd "$h" && env -u KIJITO_API_TOKEN PATH="$NOTMUX" HOME="$h" bash "$INSTALLER" --allow-branch 2>&1 ) )
if ! grep -q 'tmux not found' <<<"$out"; then red "tmux hidden but no tmux note printed - this check measured nothing"
elif grep -qi 'armed-pane autonomy + auto-send need tmux' <<<"$out"; then red "the tmux note still reads as a requirement"
else grn "a missing tmux is framed as optional"; fi

echo
echo "passed: $pass   failed: $fail"
[ "$fail" = 0 ]
