# Changelog

## Unreleased
- Tests: the M440 operator-text scanner strips only the phrase "on a cadence" instead of skipping the
  line, normalises Unicode hyphens, and catches the wider shapes of an authority claim
  (preauthorized, pre-approved, already authorized, standing directive/order) plus more names.
- Tests: `KIJITO_REMOTE_CONTROL` set to empty, `true` or `yes` is pinned to keep Remote Control off.
- README: what can type into an armed pane now includes the self-clear send and any tmux client.

## 0.2.12
- **Remote Control is now opt-in for armed launches.** `claude-armed.sh` passes `--remote-control`
  only when `KIJITO_REMOTE_CONTROL=1` (it was on by default before) and says so on stderr. Set it in
  your environment, for example the `env` block of `~/.claude/settings.json`, to keep the old behaviour.
- The shipped skills carry no operator-specific rules or claimed pre-authorizations.

## 0.2.11
- SessionStart hook: counts only real consumer tails with their ages; flags leaked orphans on Windows
  only; autosends only from the pane's own interactive session (never a headless `claude -p`).
- Inbox start judges a running producer from the process table, not the stream file's age.
- The kijito-start skill no longer ships an operator's pager topic.
