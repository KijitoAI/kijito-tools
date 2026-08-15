# codex controller era — retired at gate 6, 2026-08-15

Archive of the headless app-server-seat stack retired under the hive-user-first plan's §7
teardown protocol (gate 6). Archived per fleet data-safety (archive-don't-delete); never shipped
(`legacy/` is excluded from every payload, and CI fails if it leaks).

What this was: a supervised `codex app-server` seat on a dedicated `CODEX_HOME` — controller
(event-stream consumer + wake-turn delivery), cli (`doctor`/`status`/`smoke` observer surface),
auth binding, tmux pane-wake driver with its TUI-contract fixtures, mode register + mode-aware
watchdog (the alarm), and the hash-gated installer that placed them. The recovery runbook
(`WAKE-RECOVERY-RUNBOOK.md`) is NOT here: its removal from the tree is the gate-6 marker
(bytes in git history at `dcce0bd`).

Why retired: the evaluation and Jason's sign-off ([[28718]], goal [[28506]]) settled the
user-first shape — session-is-the-subscriber, B+C default (durable inbox + session-owned
producer; mail waits, zero loss) with the gate-5 native wake helper as the opt-in live path.
A dedicated headless seat wakes a thread the user is not in; the replacement wakes the session
the user is actually running.

Teardown of record (2026-08-15 06:43–06:58Z): controller SIGTERM'd (orderly exit = terminal
state flush + consumer-lock self-removal), mode register retired, watchdog died LAST
(`launchctl bootout`), everything archived on the operator seat at
`~/.local/share/codex-kijito-hive/legacy/gate6-20260815T0643Z/` with a full evidence README —
hive rulings 7767 (argus sequencing), 7768 (assay window grant), 7771/7783 (evidence
dispositions). The retired entries' final hashes are frozen in
`providers/codex/release-manifest.json` → `legacyArtifacts`.

Do not resurrect any of this on a live path without a new plan and steward review; the
`forbiddenMechanisms` list in the manifest still binds.
