# Changelog

## 0.2.24

- **The SessionStart hook is about 1,000 characters shorter again.** 0.2.23 grew its output from about
  1,930 to 2,940 characters in every session for every user. The common case is now about 1,800 (at
  most 2,000, pinned by `tests/catchup_size_budget_test.sh`). It still gives the one arm command, the
  re-arm-first-then-read rule, what exit 2 means and the capped Monitor fallback; the full detail (exit
  codes, the blip debounce and `--grace`, why a bare tail cannot wake anyone) moved to
  `kijito-inbox-wait.py --help` and the `kijito-start` skill.
- **`./install.sh --from-main` installs origin/main, never a stale local `main`.** It fetches
  `origin/main` and installs exactly that commit from a clean extract; if the fetch fails it refuses
  (exit 3) and installs nothing. A local `main` checked out in an old worktree could not be
  fast-forwarded, and the install silently downgraded `~/.claude`.
- **A plain `./install.sh` on `main` checks that `main` is current.** If local `main` is behind
  `origin/main` it refuses (exit 3) and names `--from-main`; if origin cannot be reached it installs
  with a one-line warning, so offline installs keep working.

## 0.2.23

- **The inbox watch no longer dies after 30 minutes.** Claude Code's Monitor tool caps every watch at
  30 minutes and has no persistent option, so the `Monitor(..., persistent=true)` line the SessionStart
  hook and the `kijito-start` skills recommended left every user's inbox deaf after half an hour (or
  woke the session every half hour only to re-arm it). The recommended consumer is now a one-shot
  waiter, `~/.claude/kijito-inbox-wait.py`, run with Bash `run_in_background`: background Bash has no
  time limit, and the waiter wakes the session by exiting on the first wake-worthy event. The agent
  re-arms it first and then reads the inbox, so nothing falls in the gap. The Monitor line remains only
  as the fallback for hosts without background Bash, with its 30-minute cap stated.
- The waiter refuses to wait on a missing stream (exit 2, with the command that starts the producer),
  because `tail -F` on a missing file waits forever and that silence reads as "no mail". It allows one
  waiter per stream (exit 4), follows the stream through a real `tail -n 0 -F` child so every existing
  consumer check still sees it, and takes `--max-wait` for callers that want a bound (exit 3).
- **Network blips no longer wake the agent.** A source-DOWN `alert` followed by `recovered` within
  `--grace` seconds (default 600) wakes nobody; one that does not recover wakes the agent with the alert
  when the window ends. Only the source-DOWN alert is held: mail, `still_unread` and every other alert
  or diagnostic wake at once. `--grace 0` restores the old behaviour.
- `inbox-selftest.sh` also checks for a consumer before it sends the test message, because the
  one-shot waiter exits on that message (its exit is the wake); a check made only afterwards called a
  working wake path NOT WORKING. On Windows the SessionStart hook no longer calls an old tail an orphan
  when a live waiter owns it. `kijito-inbox-start.sh` prints the waiter line.

## 0.2.22

- **Fix: the inbox self-test reported a working wake path as unmeasured.** Since Kijito's change of
  2026-10-28, a hive message whose sender is its own recipient is refused (409 `self_send_refused`)
  unless it carries `force: true`, because that pair is usually a mistyped sender. The install
  self-test sends one message to the agent's own persona on purpose, so it now sends `force: true`;
  before this fix every new install printed "COULD NOT MEASURE ... HTTP 409". The fallback hint for a
  read-only key now shows `force=true` as well.

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
