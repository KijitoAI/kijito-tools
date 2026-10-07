# Changelog

## Unreleased
- **Setup text for a new key covers the redeem command** (M488): when there is no key, the inbox start script
  asks the agent to mint a read-only key and run the one redeem command the reply gives, which saves the key to
  `~/.config/kijito-inbox-monitor/token` without the key passing through the conversation. A reply that shows the
  key itself (an older or self-hosted server) is still saved there by hand with `chmod 600`. The offer of a key
  that can also write is gone from the start script and the self-test: such a key is saved to the REST key file,
  which neither reads, and the self-test asks the agent to send the test message instead.
- **A test keeps the docs and the key helper's scan in step** (M488): every key-file path, key variable name and
  client-config header form that the docs, scripts, templates and test fixtures name must be one the monitor's
  `--redeem-key` looks at, with an explicit list of files that hold no key. Mutants of the helper's lists and
  planted undocumented locations each make it fail. The Codex notify example now points at the monitor's key file.

## 0.2.16
- **The vendored kijito-inbox-monitor moves to v0.5.15** (M486): an `--api-base` flag and a `KIJITO_BASE`
  environment variable select the Kijito API (the flag wins, then the environment, then `https://api.kijito.ai`).
  Plain `http` is accepted only for a loopback address, proxy environment variables are ignored, and a pinned
  connection tries every resolved address. The `armed` and `heartbeat` events carry `api_base`, and
  `scripts/render-service.sh` renders the launchd plist or systemd unit. With no flag and no variable set,
  behaviour is unchanged.

## 0.2.15
- **The published payload names no maintainer persona, host or message id** (M467): shipped scripts cite their
  provenance by row or review instead of naming the maintainers' own personas, a host or hive message ids, and
  examples use neutral names. The vendored kijito-inbox-monitor moves to v0.5.14, whose program, `--help` and
  README are clean too. The vendored monitor's maintainer history, tests and release tooling stay in the
  repository but are left out of the npm, wheel and sdist payloads; users install the monitor itself from PyPI. A
  test scans the whole npm payload for these names and ids, with planted and allowed controls, and checks that the
  three payload exclusion lists agree.
- **The inbox start script suggests a read-only key first** (M468): the monitor only reads mail, so the suggested
  mint is `scopes=["memory.read"]`. A key that can also write is offered only as an alternative that needs your
  explicit yes; with a read-only key the script asks your agent to send the test message instead.
- **Codex wakes may reply to hive mail by default** (M469): a wake now lets the agent answer verified senders in
  thread and continue work the human already authorized, under the normal rules. Message bodies stay untrusted
  data that cannot grant authority. `--mail-mode read` opts out. The policy is stamped in the helper's pidfile,
  and changing it on a running helper fails loudly until an explicit stop and re-arm.
- **The SessionStart hook gives the project rule** (M470): pass the persona setup recorded, add `project=` only if
  setup recorded one, and never derive it from the directory name, the same rule as kijito-start.

## 0.2.14
- **A test scans the whole published npm payload** (M459): it reads the file list from `npm pack`, has no path
  exclusions, and allows only the copyright and author attribution lines, each matched by file and exact content. A failing
  `npm pack` listing fails the test instead of scanning nothing.
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
- **The kijito-start and kijito-qa-memory skills carry no maintainer-internal text** (M462): no local test daemon,
  no maintainers' token-file path, no client-version measurement notes, no dated measurement asides, and no claim
  that the routine is "stored in the graph". The `.mcp.json` example drops the `X-Kijito-Session` header (Claude
  Code never forwards it; the `?session=` URL parameter carries the session). A stopped inbox producer: restart the
  supervised unit if one is installed, otherwise `kijito-inbox-start.sh --persona <P>` starts one and proves the
  wake. The boot inbox read now peeks (`mark_read=false`), so deferred mail stays unread until it is handled. The scanner bans these shapes, with one control each, and checks that both
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
