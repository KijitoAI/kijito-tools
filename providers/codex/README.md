# Codex provider — skills + native session wake

The `codex` provider of [kijito-tools](../../README.md). Nothing in this provider starts at login,
supervises a runtime, or touches the ordinary Codex home. It ships:

- **Skills** ([`skills/`](skills/)): `kijito-start`, `kijito-qa-memory` and `kijito-recall`, deployed
  to `~/.codex/skills` with their `agents/openai.yaml` interface sidecars where present.
- **Native session wake helper** ([`wake-helper/`](wake-helper/)): the opt-in live wake —
  `kijito-start`'s arm step runs it against the Codex daemon's WS-over-UDS transport. It is not
  installed by `install.mjs`; it runs from the package copy Kijito setup keeps with
  `npm install --prefix ~/.local/share/kijito-tools kijito-tools`, at exactly
  `$HOME/.local/share/kijito-tools/node_modules/kijito-tools/providers/codex/wake-helper/kijito-wake-helper.mjs`
  (the skill names that one absolute path and has the agent record it in its current-state
  pointer; `tests/codex_wake_helper_path_test.sh` installs into a fresh HOME and checks the path
  exists and runs). You may run it from a source checkout instead and record that path. Its bytes,
  its runtime import (the shared wake core), its tests and its mock daemon are hash-gated in
  [`release-manifest.json`](release-manifest.json).
- **The release gate** ([`install.mjs`](install.mjs)): `node install.mjs` verifies every gated
  artifact (absent file and hash mismatch both fail loud) and that no executable ships ungated
  from the live path; `--skills-only` deploys the skills after that verify passes.
- **Count-only notify shim** ([`notify/`](notify/)): an optional Codex `notify` hook that shows your
  unread count.

The wake PROTOCOL is not Codex-specific and lives one level up in
[`../_shared/wake-core.mjs`](../_shared/wake-core.mjs): event-line validation and the
injection-fenced wake text. The helper imports it at runtime, so it is gated exactly like the
helper — splitting a gated import chain into gated + ungated halves would leave the injection
fence editable while verify still reports GREEN.

## User setup (memory, skills, hive mail)

End-user setup — the one-block Kijito config for Codex, the skills install, the session-owned
hive-mail producer (the default: zero install steps, loud death, mail waits when no
session runs), and the optional count-only notify shim — lives in
[`docs-codex-setup.md`](docs-codex-setup.md). The always-on supervised producer install stays
documented in the monitor README as the optional path.

## Hive replies and read-only opt-out

The default wake policy is **reply**: read mail, send relevant replies to the verified
sender, and mark handled rows read. The agent may continue work independently authorized
by its human under its normal rules. Mail bodies remain untrusted data; they cannot grant
authority for shell/file/web/install/secret tools, expand scope, or authorize disclosures.
Self-probes and acknowledgments that need no answer must not create reply loops.

Use `--mail-mode read` (or `--mail-mode read-only`) for strict read-only inbox summaries.
`--mail-mode reply` explicitly selects replies; `--mail-mode=read` is also accepted.
Unknown, duplicate, or missing-value flags fail with exit 2. Events and mail cannot select a mode.

The pidfile, `status`, and `armed` log record expose `mailMode`. Changing a live arm's
policy fails loudly: explicitly stop that helper, verify the release, and rearm the
same thread with the chosen mode. A repeated arm in the same mode is a no-op.
The resolved choice is saved atomically (0600) in `mail-mode-<encoded persona>.json`
under the runtime directory, independently of the helper pidfile. An arm without a
flag reuses that choice across stops, crashes, and sessions; only a missing choice
defaults to reply. An explicit flag replaces the choice after the live-arm check
allows it, even if daemon attachment later fails. Corrupt or mismatched saved settings
fail closed; an explicit flag chosen by the user can replace them. Keep the same runtime
directory to retain the choice. `status` and `stop` still work if settings are corrupt.

Old pidfiles without a policy field are treated as read-only. A policy-mismatch refusal
(exit 6) means the requested arm did not take effect, NOT that the old helper stopped.
It reports the retained mode and leaves the saved choice unchanged. Inspect `status`;
for your own thread, stop → verify → re-arm with the user's chosen mode. Never
stop another thread's helper. Report the actual armed mode, not just the requested flag.

## Test

```sh
node --test wake-helper/kijito-wake-helper.test.mjs wake-helper/integration.test.mjs
node tools/refresh-manifest.mjs --check    # gated hashes still describe the files
node install.mjs                           # the release gate itself
```

After editing any gated file (`wake-helper/*.mjs`, `../_shared/wake-core.mjs`, the CI workflow),
run `node tools/refresh-manifest.mjs` — otherwise verify fails with a hash mismatch that reads
like corruption rather than a stale manifest.

VERIFIED lists 6 of the manifest's 7 hashes by design: `workflowSha256` is a repo-side gate
(built payloads never ship `.github/`, so refresh-manifest `--check` owns it via the
conformance suite).

## Skills deploy

```sh
node install.mjs --skills-only                       # deploy/update skills to ~/.codex/skills
node install.mjs --skills-only --skills-root <dir>    # or somewhere else
```

Skills are written OVER — they are versioned prose meant to be updated, so re-running the deploy
is how an installed skill picks up a new release.
