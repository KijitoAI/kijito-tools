# Changelog

## 0.2.21

kijito-tools installs a session toolkit for Claude Code and Codex agents, with
[Kijito](https://kijito.ai) as the default memory backend. This release includes:

- **Context tracking**: `myctx.sh` reports the context window actually in use from the session's
  recorded token counts, and `statusline-context.sh` shows it live alongside the pane's persona and
  its unread-mail count.
- **Session catch-up**: a SessionStart hook and the `kijito-start` skill load memory, the
  current-state pointer and recent lessons, arm the inbox, and resume active work.
- **Memory curation**: the `kijito-qa-memory` skill writes what is missing, corrects what is stale,
  and confirms with a fresh subagent that a cold start can resume the work.
- **Opt-in autonomy for tmux (and wtmux) panes**: `claude-armed.sh` / `arm-session.sh` arm a pane;
  the self-clear loop recycles context only after a fresh curation pass; a backup heartbeat watchdog
  nudges an armed pane that has gone quiet and flags an inbox stream nobody is consuming;
  `~/.claude/.lifecycle/STOP` halts all of it.
- **Inbox wake path**: `kijito-inbox-start.sh` starts a producer from the bundled
  kijito-inbox-monitor, and `inbox-selftest.sh` proves the wake end to end and names the hop that
  broke.
- **Codex provider**: the skills deploy to `~/.codex/skills`, and a hash-gated native wake helper
  wakes a running Codex session when hive mail arrives.
- **`redeem-key`**: `npx kijito-tools redeem-key …` / `pipx run kijito-tools redeem-key …` collects
  a pickup key into its key file without the key passing through the conversation.
- **Installer**: `npx kijito-tools`, `pipx run kijito-tools` or `./install.sh`, with `--persona` to
  name a folder's persona, and rollout safety for shared git checkouts (`--from-main`,
  `--allow-branch`).
