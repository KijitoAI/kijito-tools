#!/usr/bin/env bash
# The Codex kijito-start skill names the wake helper by the path the package copy really has.
#
# WHY THIS EXISTS (row M502, from the M456 Codex cold run #2 on 2026-10-08, finding N2). Kijito setup's
# wake step keeps a copy of this package with `npm install --prefix ~/.local/share/kijito-tools
# kijito-tools`, so the helper lands at ~/.local/share/kijito-tools/node_modules/kijito-tools/providers/
# codex/wake-helper/kijito-wake-helper.mjs. The kijito-start skill named only the package-relative path
# (providers/codex/wake-helper/kijito-wake-helper.mjs) and the agent's state note recorded only the
# --prefix directory, so session 2 ran node ~/.local/share/kijito-tools/providers/codex/wake-helper/...,
# got "Cannot find module", and fell back to catch-up only. Any later re-arm on a new thread would hit
# the same wall.
#
# What this asserts:
#   1. text: every path the skill gives for the helper is ONE absolute path (the one below); it never
#      calls the helper as a bare `kijito-wake-helper` command (no such command is installed); and it
#      tells the agent to record the path in its current-state pointer.
#   2. install: `npm pack` this checkout, `npm install --prefix <fresh HOME>/.local/share/kijito-tools`
#      the tarball, then run `npx kijito-tools --provider codex --skills-only` from the same tarball in
#      that HOME. The path the DEPLOYED skill names must exist there and run (`status` prints
#      `not-armed`).
#   3. controls: mutated skills (the pre-fix relative path, the session-2 guess without
#      node_modules/kijito-tools, a bare-command call, the record sentence removed) must each fail.
#
#   bash tests/codex_wake_helper_path_test.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$REPO/providers/codex/skills/kijito-start/SKILL.md"
# The ONE path. Must match the Kijito engine's Codex wake step (setup_texts.py _CODEX_PKG +
# /providers/codex/wake-helper/kijito-wake-helper.mjs).
WANT='$HOME/.local/share/kijito-tools/node_modules/kijito-tools/providers/codex/wake-helper/kijito-wake-helper.mjs'
pass=0; fail=0
red() { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
grn() { printf "  ok    %s\n" "$1"; pass=$((pass+1)); }

# Prints one line per problem with the skill text in $1; prints nothing when it is right.
text_problems() {
  local f="$1" paths p flat
  # Every token that is a path to the helper file (contains a slash). The bare file name alone, as in
  # "a full path ending in kijito-wake-helper.mjs", is not a path and is allowed.
  paths=$(grep -oE '[^][:space:]"`(){}<>]*/kijito-wake-helper\.mjs' "$f" | sort -u)
  [ -n "$paths" ] || echo "names no path for kijito-wake-helper.mjs at all"
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    [ "$p" = "$WANT" ] || echo "names a second helper path: $p"
  done <<< "$paths"
  # A bare command form: nothing installs a `kijito-wake-helper` executable on PATH.
  if grep -nE '(^|[`[:space:]])kijito-wake-helper[[:space:]]+(arm|run|status|stop)([[:space:]]|$)' "$f" >/dev/null; then
    echo "calls the helper as a bare kijito-wake-helper command"
  fi
  # The record instruction (may wrap over lines, so flatten first).
  flat=$(tr '\n' ' ' < "$f" | tr -s ' ')
  if ! printf '%s' "$flat" | grep -qiE 'record the helper path you used, in full, in your current-state pointer'; then
    echo "does not tell the agent to record the helper path in its current-state pointer"
  fi
}

echo "== the kijito-start skill (Codex) names one absolute helper path =="
probs=$(text_problems "$SKILL")
if [ -z "$probs" ]; then grn "one helper path ($WANT), no bare command, record instruction present"
else red "skill text:"; printf '        %s\n' "$probs"; fi

echo "== controls: mutated skills must fail =="
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mutant() {  # $1 = label, $2 = python replace expression applied to the skill text
  local m="$T/mutant.md"
  python3 - "$SKILL" "$m" "$2" <<'PY'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src).read()
t = eval(expr, {"s": s})
open(dst, "w").write(t)
sys.exit(0 if t != s else 3)
PY
  case $? in
    0) ;;
    *) red "control '$1': the mutation did not change the skill (stale control)"; return ;;
  esac
  if [ -n "$(text_problems "$m")" ]; then grn "control '$1' is caught"
  else red "control '$1' PASSED the text check - the check cannot be trusted"; fi
}
mutant "pre-fix relative path" \
  's.replace("$HOME/.local/share/kijito-tools/node_modules/kijito-tools/providers/codex/wake-helper/kijito-wake-helper.mjs", "providers/codex/wake-helper/kijito-wake-helper.mjs", 1)'
mutant "session-2 guess (no node_modules/kijito-tools)" \
  's.replace("kijito-tools/node_modules/kijito-tools/providers", "kijito-tools/providers", 1)'
mutant "bare command call" \
  's.replace("node \"$HOME/.local/share/kijito-tools/node_modules/kijito-tools/providers/codex/wake-helper/kijito-wake-helper.mjs\" \\\n       arm", "kijito-wake-helper arm", 1)'
mutant "record instruction removed" \
  's.replace("Record the helper path you", "Note the helper you", 1)'

echo "== install into a fresh HOME: the advertised path exists and runs =="
if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  red "npm/node not on PATH - cannot check the installed path (this is a FAIL, not a skip: the check is the point)"
else
  H="$T/home"; mkdir -p "$H"
  export npm_config_cache="$T/npm-cache" npm_config_update_notifier=false
  if ! (cd "$REPO" && npm pack --silent --pack-destination "$T" >"$T/pack.log" 2>&1); then
    red "npm pack failed:"; sed 's/^/        /' "$T/pack.log"
  else
    TGZ=$(ls "$T"/kijito-tools-*.tgz | head -1)
    # Exactly the wake step's command, with a fresh HOME and the local tarball for the registry name.
    if HOME="$H" npm install --prefix "$H/.local/share/kijito-tools" "$TGZ" \
         --ignore-scripts --no-audit --no-fund --offline >"$T/install.log" 2>&1; then
      grn "npm install --prefix \$HOME/.local/share/kijito-tools <tarball> succeeded"
    else
      red "npm install --prefix failed:"; sed 's/^/        /' "$T/install.log"
    fi
    # What a stranger runs for the skills: npx kijito-tools --provider codex --skills-only.
    if (cd "$T" && HOME="$H" npx -y --offline --package "$TGZ" kijito-tools --provider codex --skills-only \
          >"$T/skills.log" 2>&1) && grep -q '"SKILLS_INSTALLED"' "$T/skills.log"; then
      grn "npx kijito-tools --provider codex --skills-only printed SKILLS_INSTALLED"
    else
      red "npx kijito-tools --provider codex --skills-only did not install the skills:"; sed 's/^/        /' "$T/skills.log"
    fi
    DEPLOYED="$H/.codex/skills/kijito-start/SKILL.md"
    if [ -f "$DEPLOYED" ] && cmp -s "$DEPLOYED" "$SKILL"; then grn "deployed kijito-start skill is byte-identical to the repo's"
    else red "deployed kijito-start skill missing or differs from the repo's ($DEPLOYED)"; fi
    if [ -f "$DEPLOYED" ]; then
      dprobs=$(text_problems "$DEPLOYED")
      [ -z "$dprobs" ] && grn "deployed skill names the one helper path" || { red "deployed skill text:"; printf '        %s\n' "$dprobs"; }
      # The path the deployed skill gives, expanded the way the agent's shell will expand it.
      ADV=$(grep -oE '[^][:space:]"`(){}<>]*/kijito-wake-helper\.mjs' "$DEPLOYED" | sort -u | head -1)
      REAL="${ADV/\$HOME/$H}"
      if [ -f "$REAL" ]; then grn "advertised path exists after the install: ${ADV}"
      else red "advertised path does NOT exist after the install: $REAL"; fi
      out=$(HOME="$H" node "$REAL" status --persona m502-probe 2>&1); rc=$?
      if [ "$out" = "not-armed" ] && [ "$rc" = 1 ]; then grn "node <advertised path> status runs (not-armed, exit 1)"
      else red "node <advertised path> status: rc=$rc out=$out"; fi
      # The session-2 guess must NOT exist, or the control above would be testing nothing real.
      GUESS="$H/.local/share/kijito-tools/providers/codex/wake-helper/kijito-wake-helper.mjs"
      if [ ! -e "$GUESS" ]; then grn "control: the session-2 guessed path is absent in a real install"
      else red "control: the session-2 guessed path exists - the install layout changed; re-check M502"; fi
    fi
  fi
fi

echo
echo "codex wake helper path: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
