#!/bin/sh
# Kijito plugin: SessionStart reminder to catch up from memory.
# Loads in Cowork and Claude Code; chat (claude.ai) ignores plugin hooks.
#
# Stays SILENT when the kijito-tools Claude Code hook is installed, so a kijito-tools user never gets
# two reminders. providers/claude/install.sh installs that hook as two things, and both must be true:
#   1. the script  ~/.claude/session-catchup-hint.sh
#   2. a SessionStart entry in ~/.claude/settings.json whose command names session-catchup-hint
# A script with no settings entry never runs, so it does not count as installed.
#
# POSIX sh, no network, and it always exits 0: a reminder must never fail a session start.

for dir in "${CLAUDE_CONFIG_DIR:-}" "${HOME:-}/.claude"; do
  [ -n "$dir" ] || continue
  if [ -f "$dir/session-catchup-hint.sh" ] &&
     grep -q 'session-catchup-hint' "$dir/settings.json" 2>/dev/null; then
    exit 0
  fi
done

cat <<'MSG' 2>/dev/null
Kijito memory: before you start on the user's task, catch up with the kijito-catch-up skill (or /kijito:catch-up). Call kijito_startup once (pass persona= only if the user or their memory names one), read the current-state note it names in full with kijito_get, and call kijito_recall before answering anything that may already be in memory. As decisions, preferences and finished work come up, and before the session ends, save them with the kijito-save skill: one insight per kijito_remember, kijito_correct what is now wrong, and never save secrets. If the Kijito tools are not connected, say so once, point the user to the Kijito plugin's Connectors tab, and carry on.
MSG
exit 0
