# Changelog

## 0.2.14
- **A test scans the whole published npm payload** (M459): it reads the file list from `npm pack`, has no path
  exclusions, and allows only the copyright and author attribution lines, each matched by file and exact content.
- **The packages no longer ship the Codex provider's maintainer material** (M459): `providers/codex/test/`,
  `plans/`, `n0-harness/` and the plan documents stay in the repository and are left out of the npm, wheel and
  sdist payloads. Nothing an installer runs changes: the Codex installer's hash-gated set (`wake-helper/` and
  `_shared/wake-core.mjs`) still ships and verifies from the package. The wheel now pulls `providers/` in
  through `hatch_build.py` (still the whole tree, minus that list), and CI asserts the exclusion on all three
  payloads.
- **kijito-start takes the project setup recorded, never the directory name** (M461): the project the project
  instructions name, else the one the identity memory and pointer were filed under, else no project argument at
  all. A new persona's setup now records the project it chose, so later sessions pass the same value. Both the
  Claude Code and the Codex skill.
- **The shipped skills carry no maintainer-internal text** (M462): no local test daemon, no maintainers' token-file
  path, no client-version measurement notes, no dated measurement asides, and no claim that the routine is
  "stored in the graph". A stopped inbox producer now points to `kijito-inbox-start.sh --persona <P>`, which
  starts it and proves the wake. The scanner bans these shapes, with one control each, and checks that both
  kijito-start skills keep the project rule.

## 0.2.13
- Vendored kijito-inbox-monitor 0.5.13: its comments and test fixtures no longer name the operator, and a test
  keeps it that way. No behaviour change.
- The Codex skills no longer hardcode a persona or name the operator's fleet: they use `<persona>` and
  `<project>` placeholders, including the Claude Code fallback's stream path, producer unit and idempotency
  check (which named the `codex` persona's stream, so another persona tailed a file that never exists).
  The scanner now covers `providers/codex/skills`, catches a concrete persona in any quoting or in a stream or
  producer name, normalises non-breaking spaces, and scans shipped `.service`/`.template` files too.
- Tests: the M440 operator-text scanner strips only the phrase "on a cadence" instead of skipping the
  line, normalises Unicode hyphens, and catches the wider shapes of an authority claim
  (preauthorized, pre-approved, already authorized, standing directive/order) plus more names.
- Tests: `KIJITO_REMOTE_CONTROL` set to empty, `true` or `yes` is pinned to keep Remote Control off.
- README: what can type into an armed pane now includes the self-clear send and any tmux client.
- The shipped scripts no longer quote the operator by name or cite a person's instruction as the reason
  for a behaviour (self-clear, inbox-selftest, session-autosend, kijito-persona-lib, heartbeat-watchdog,
  session-catchup-hint). A new test fails if an operator name or an authority claim reappears in any
  shipped `.sh`/`.mjs`/`.js`/`.py` file (M459).

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
