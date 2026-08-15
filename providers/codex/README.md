# Codex provider — skills + native session wake

> **GATE 6 (2026-08-15): the controller era is over.** The headless app-server-seat stack
> (controller, cli/doctor, pane-wake driver, mode register, mode-aware watchdog) was retired under
> the hive-user-first plan's §7 teardown protocol: machinery stopped and archived on the operator
> seat, mode register retired, and the recovery runbook removed (that removal is the gate-6
> marker). The code is archived under
> [`../../legacy/codex-controller-era-2026-08/`](../../legacy/codex-controller-era-2026-08/) and its
> gated hashes are frozen in the manifest's `legacyArtifacts` block. Nothing in this provider
> starts at login, supervises a runtime, or touches the ordinary Codex home.

The `codex` provider of [kijito-claude](../../README.md). What is live:

- **Skills** ([`skills/`](skills/)): `kijito-start` and `kijito-qa-memory`, deployed to
  `~/.codex/skills` with their `agents/openai.yaml` interface sidecars.
- **Native session wake helper** ([`wake-helper/`](wake-helper/)): the gate-5 opt-in live wake —
  `kijito-start`'s arm step runs it from the checkout against the Codex daemon's WS-over-UDS
  transport (gate-4 battery certified 2/2, gate-5 merged at `dcce0bd`). It is never installed;
  its bytes, its runtime import (the shared wake core), its tests and its mock daemon are
  hash-gated in [`release-manifest.json`](release-manifest.json).
- **The release gate** ([`install.mjs`](install.mjs)): `node install.mjs` verifies every gated
  artifact (absent file and hash mismatch both fail loud) and that no executable ships ungated
  from the live path; `--skills-only` deploys the skills after that verify passes.
- **N0 harness** ([`n0-harness/`](n0-harness/), `test/n0-*`): the disposable capability-probe
  harness and its closed-world guard census — self-contained, unaffected by the retirement.

The wake PROTOCOL is not Codex-specific and lives one level up in
[`../_shared/wake-core.mjs`](../_shared/wake-core.mjs): event-line validation and the
injection-fenced wake text. The helper imports it at runtime, so it is gated exactly like the
helper — splitting a gated import chain into gated + ungated halves would leave the injection
fence editable while verify still reports GREEN.

[`codex-kijito-parity-plan.md`](codex-kijito-parity-plan.md) is RECORDED for provenance (its hash
is carried in the manifest, deliberately not gated — hash-gating a release on a prose document was
a real defect, fixed in the 2026-07-30 fold). The withdrawn dedicated-thread notifier history
(PR #5, live message 2630) and the same-chat continuation plans remain in
[`same-chat-continuation-plan.md`](same-chat-continuation-plan.md) and the plan documents for
review only.

## User setup (memory, skills, hive mail)

End-user setup — the one-block Kijito config for Codex, the skills install, the session-owned
hive-mail producer (the measured default: zero install steps, loud death, mail waits when no
session runs), and the optional count-only notify shim — lives in
[`docs-codex-setup.md`](docs-codex-setup.md). The always-on supervised producer install stays
documented in the monitor README as the optional path.

## Test

```sh
node --test wake-helper/kijito-wake-helper.test.mjs wake-helper/integration.test.mjs
node tools/refresh-manifest.mjs --check    # gated hashes still describe the files
node install.mjs                           # the release gate itself
```

After editing any gated file (`wake-helper/*.mjs`, `../_shared/wake-core.mjs`, the CI workflow),
run `node tools/refresh-manifest.mjs` — otherwise verify fails with a hash mismatch that reads
like corruption rather than a stale manifest.

## Skills deploy

```sh
node install.mjs --skills-only                       # deploy/update skills to ~/.codex/skills
node install.mjs --skills-only --skills-root <dir>    # or somewhere else
```

Unlike the retired install root, skills are written OVER — they are versioned prose meant to be
updated. This path exists because both skills were, until the fold, present only at
`~/.codex/skills` with no upstream in any repository: version-controlling them without a way to
deploy them would have left the rescue half-done.
