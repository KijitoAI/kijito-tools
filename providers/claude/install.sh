#!/usr/bin/env bash
# kijito-tools — the CLAUDE provider's installer. Deploys the toolkit into ~/.claude and merges
# settings.json. Idempotent + non-destructive: backs up settings.json, jq-merges keys (no clobber),
# de-dups the hook. Also the cross-machine/fleet installer: clone the repo on any box and run this.
#
# Normally reached through the repo-root dispatcher (`./install.sh`, which defaults to this
# provider); running it directly works too. Its assets are resolved relative to THIS file, which is
# why moving it into providers/claude/ during the 2026-07-30 provider split needed no path edits.
set -euo pipefail
PROVIDER_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude"
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required."; exit 1; }
command -v tmux >/dev/null 2>&1 || echo "WARN: tmux not found — armed-pane autonomy + auto-send need tmux. (Context self-check works without it.)"

mkdir -p "$DEST/skills" "$DEST/.lifecycle"

# 1) scripts → ~/.claude (executable)
for s in "$PROVIDER_ROOT"/scripts/*.sh; do install -m 0755 "$s" "$DEST/$(basename "$s")"; done
echo "✓ scripts installed → $DEST"

# 2) skills (optional helpers — every skill in skills/ gets deployed)
for d in "$PROVIDER_ROOT"/skills/*/; do
  name="$(basename "$d")"
  [ -f "$d/SKILL.md" ] || continue
  mkdir -p "$DEST/skills/$name"
  install -m 0644 "$d/SKILL.md" "$DEST/skills/$name/SKILL.md"
  echo "✓ skill: $name"
done

# 2b) the CLAUDE.md doctrine snippet — copied alongside so npx/pipx users (who never cloned
# the repo) still have it to paste into ~/.claude/CLAUDE.md.
if [ -f "$PROVIDER_ROOT/CLAUDE.md.snippet" ]; then
  install -m 0644 "$PROVIDER_ROOT/CLAUDE.md.snippet" "$DEST/kijito-tools.CLAUDE.md.snippet"
  echo "✓ doctrine snippet → $DEST/kijito-tools.CLAUDE.md.snippet"
fi

# 3) settings.json — merge statusLine / totalTokensReminder / env / SessionStart hook (idempotent)
#
# ⚠️ MODE IS PART OF THE CONTRACT, NOT A DETAIL. This file's `env` block is where a
# KIJITO_API_TOKEN lives — a bearer token for the whole account's memory graph — so it must be
# owner-only. Every write below goes through a file we chmod 0600 BEFORE it becomes settings.json.
# The defect this guards: `jq ... > tmp` then `mv tmp settings.json` creates tmp under the AMBIENT
# UMASK and mv carries that mode over, silently downgrading an existing 0600 to 0664 (umask 002) or
# 0644 (umask 022). Because the installer is advertised as safe to re-run, it re-armed on every
# run — a user who fixed the mode by hand lost the fix at the next install, with no warning.
SET="$DEST/settings.json"

# ⚠️ FOLLOW A SYMLINK INSTEAD OF REPLACING IT (assay, second-operator review of 0.1.3).
# `mv tmp settings.json` REPLACES a symlink with a regular file. The live config ends up correct, so
# nothing looks wrong — but a dotfiles-managed setup (settings.json -> ~/dotfiles/claude/settings.json)
# is silently de-linked, future dotfile updates stop reaching Claude, AND the abandoned target keeps
# a copy of the KIJITO_API_TOKEN at its old mode in its old location. That is the same defect this
# release fixes, just relocated. Resolve the link and write THROUGH it.
#
# Portable resolver: BSD `readlink` has no -f (macOS < 12), so walk the chain by hand. Bounded at 10
# hops so a symlink loop cannot hang the installer.
_resolve_link() {
  _rl_p="$1"; _rl_i=0
  while [ -L "$_rl_p" ] && [ "$_rl_i" -lt 10 ]; do
    _rl_t="$(readlink "$_rl_p")"
    case "$_rl_t" in
      /*) _rl_p="$_rl_t" ;;
      *)  _rl_p="$(dirname "$_rl_p")/$_rl_t" ;;
    esac
    _rl_i=$((_rl_i+1))
  done
  printf '%s' "$_rl_p"
}
SET_REAL="$(_resolve_link "$SET")"
[ "$SET_REAL" = "$SET" ] || echo "  note: settings.json is a symlink → writing through to $SET_REAL"

# Portable mode read. ⚠️ NOT `stat -f … || stat -c …`: GNU's -f means "filesystem", SUCCEEDS, and the
# fallback never fires (the exact trap fixed in tests/drift_test.sh). Try GNU, then VALIDATE THE
# RESULT rather than the exit status.
_mode_of() {
  _mo="$(stat -c '%a' "$1" 2>/dev/null)"
  case "$_mo" in ''|*[!0-7]*) _mo="$(stat -f '%Lp' "$1" 2>/dev/null)" ;; esac
  case "$_mo" in ''|*[!0-7]*) _mo="" ;; esac
  printf '%s' "$_mo"
}

FRESH=0
if [ ! -e "$SET_REAL" ]; then
  FRESH=1
  # Create it locked down FIRST, then write — never the other way round, or the token-bearing
  # file exists world-readable for the window in between.
  : > "$SET_REAL"; chmod 0600 "$SET_REAL"; echo '{}' > "$SET_REAL"
fi
PREV_MODE="$(_mode_of "$SET_REAL")"

# Back up only a PRE-EXISTING file. A fresh install used to leave a `settings.json.bak.<ts>`
# containing `{}` — pure noise that makes the backup directory harder to read at the moment it
# matters, and implies a prior config that never existed.
BAK=""
if [ "$FRESH" = 0 ]; then
  BAK="$SET_REAL.bak.$(date +%Y%m%d%H%M%S)"
  cp "$SET_REAL" "$BAK"; chmod 0600 "$BAK"   # a backup of a secret is still a secret
fi
HOOK=$(jq -n --arg cmd "bash $DEST/session-catchup-hint.sh" \
  '{matcher:"startup|clear|compact", hooks:[{type:"command", command:$cmd}]}')
jq --arg home "$DEST" --argjson hook "$HOOK" '
  .statusLine = {type:"command", command:("bash " + $home + "/statusline-context.sh"), padding:0}
  | .totalTokensReminder = (.totalTokensReminder // "countdown")
  | .env = ((.env // {}) + {KIJITO_AUTOCATCHUP_DELAY: ((.env.KIJITO_AUTOCATCHUP_DELAY) // "4.0")})
  | .hooks = (.hooks // {})
  | .hooks.SessionStart = (
      ((.hooks.SessionStart // [])
        | map(select([ (.hooks[]?.command // "") ] | any(test("session-catchup-hint")) | not)))
      + [$hook] )
' "$SET_REAL" > "$SET_REAL.tmp"
jq -e . "$SET_REAL.tmp" >/dev/null
# chmod the temp file BEFORE the rename, not settings.json after it: mv is atomic, so there is
# never a moment where the live file exists with the wrong mode. Doing it after would leave a
# readable window, and would silently do nothing at all if the mv failed.
chmod 0600 "$SET_REAL.tmp"
mv "$SET_REAL.tmp" "$SET_REAL"

# ⚠️ SAY SO WHEN THE MODE CHANGED. Tightening 0644 → 0600 is correct (a settings.json holding a
# bearer token has no legitimate other-reader, and assay's review endorsed it), but doing it
# SILENTLY is wrong: the output read "mode 0600" identically whether it had been 0600 all along or
# had just been changed underneath the user. A deliberate loosening should be visibly reverted, not
# quietly undone — otherwise the installer is making a policy decision the operator cannot see.
if [ -n "$PREV_MODE" ] && [ "$PREV_MODE" != "600" ] && [ "$FRESH" = 0 ]; then
  echo "  ⚠️  tightened settings.json $PREV_MODE → 600 (it holds a bearer token; no other user should read it)"
fi
if [ "$FRESH" = 1 ]; then
  echo "✓ settings.json created, mode 0600"
else
  echo "✓ settings.json merged, mode 0600 (backup: $BAK)"
fi

echo
echo "Next: add the doctrine snippet to your ~/.claude/CLAUDE.md (context self-check + session-start"
echo "catch-up + self-clear gate). It's at $DEST/kijito-tools.CLAUDE.md.snippet"
echo
# ⚠️ SAY THE RESTART PLAINLY, AND SAY WHAT IT AFFECTS. Reported from the first external onboarding:
# the skills simply did not appear, and nothing had told the user that a RUNNING session cannot pick
# them up. "restart a running session to apply" was already here, buried at the end of a sentence
# about something else - which is the same as not saying it.
echo "⚠️  RESTART CLAUDE CODE NOW. Hooks, skills and the status line are read at session START:"
echo "    a session that is already running will NOT see anything installed above, and the skills"
echo "    will look missing rather than broken. Quit and relaunch before judging the install."
echo
echo "Verify context self-check now:  ~/.claude/myctx.sh"

# ── PROVE THE WAKE PATH RATHER THAN DECLARING IT (row M304) ──────────────────────────────────────
# An installer that prints ✓ lines and exits 0 has reported on ITSELF. The thing the user actually
# bought is that a message wakes their agent, and that is a different claim with a different failure
# mode: it fails as SILENCE. Measured on the first external install - the inbox did not arm, the
# first real message never woke anyone, and the HUMAN had to notice the quiet and ask for a
# diagnosis. Every ✓ printed above was true at the time.
echo
echo "── inbox wake path ────────────────────────────────────────────────────────────────────────"
if [ -x "$DEST/inbox-selftest.sh" ]; then
  set +e
  "$DEST/inbox-selftest.sh" ${SELFTEST_PERSONA:+--persona "$SELFTEST_PERSONA"}
  st=$?
  set -e
  # ⛔ WHICH HOPS ARE THE INSTALLER'S TO FAIL ON, AND WHY IT IS NOT ALL OF THEM. Producer and stream
  # are this installer's business and a failure there means the install did not work - exit non-zero
  # so any automation sees it. The CONSUMER hop is armed by an agent SESSION, which does not exist
  # yet at install time; failing the install for it would make every correct first install look
  # broken. So a consumer-only failure is reported loudly as the required next step and does not
  # fail the install. The one thing that must never happen - and the reason this block exists - is
  # the install reporting success while the wake path is dead.
  if [ "$st" -eq 0 ]; then
    echo "✓ wake path PROVEN end to end (a real message reached your stream and a consumer read it)."
  elif [ "$st" -eq 2 ]; then
    echo "⚠️  The wake path could NOT BE TESTED (see above) - that is not the same as working."
    echo "    Re-run it once a persona marker and token are in place:  $DEST/inbox-selftest.sh"
  elif "$DEST/inbox-selftest.sh" --no-send ${SELFTEST_PERSONA:+--persona "$SELFTEST_PERSONA"} \
         >/dev/null 2>&1; then
    # --no-send passing means producer+stream are fine and only the consumer hop is missing: the
    # normal state of a correct fresh install.
    echo "→ Install is complete and proven as far as your event stream. The WAKE is not proven yet:"
    echo "  arm a consumer in your first session (the SessionStart hint prints the exact command),"
    echo "  then re-run:  $DEST/inbox-selftest.sh"
  else
    echo "✗ THE INBOX WAKE PATH IS BROKEN - the verdict above names the failing hop."
    echo "  Fix it before relying on this install: mail will not wake your agent, and the failure"
    echo "  is silent, so nothing else will tell you."
    exit 1
  fi
else
  echo "⚠️  inbox-selftest.sh was not installed, so the wake path was NOT verified."
fi
