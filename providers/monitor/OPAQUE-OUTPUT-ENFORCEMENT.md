# Opaque output enforcement (P0-F29/A29)

**Steward:** argus · **Date:** 2026-08-17 · **Row:** `P0-F29`/`A29`, anchor `monitor-foundation-v1`
(clause: *opaque output*). This is the **certify + enforce** half of the row — the `--no-content`
capability already exists in shipped code, so nothing is built here; it is made non-optional in the
shipped deployment surface and guarded against regression.

## What is enforced

The producer's `--no-content` flag (`kijito_inbox_monitor.py`, arg at `--no-content`, applied at
`Emitter._clip`) omits message content entirely: event rows carry the message's identity, kind, and
signals, but no body. This is the publishable privacy boundary — an event stream that leaks bounded
mail excerpts is not shippable.

Both shipped service templates now pass `--no-content`, so a producer deployed from either supervisor
runs opaque by construction:

- `com.kijito.inbox-monitor.plist.template` (macOS launchd) — `<string>--no-content</string>` in
  `ProgramArguments`.
- `kijito-inbox-monitor@.service.template` (Linux systemd user unit) — `--no-content` in `ExecStart`.

## How it is guarded (acceptance tests)

`test_kijito_monitor.py :: OpaqueOutputEnforcementTest` — two independent legs:

1. **Behavior** — `Emitter(..., no_content=True)._clip(<body>)` returns `None` (content dropped),
   with a control case proving that without the flag the same input is retained (so the assertion
   proves the flag, not a constant).
2. **Deployment regression guard** — reads each template file and asserts `--no-content` is present.
   Removing the flag from either template fails this test. This is what makes "enforced" durable
   rather than a one-time edit.

Full suite green (413 tests) on 2026-08-17.

## Explicitly NOT done here (deferred)

- **The live producer flip is NOT performed by this change.** The macOS producer today runs *without*
  `--no-content` (loom's eval §5.5 measured bounded excerpts in live rows). Flipping the live Mac/VM
  producers to opaque is a fleet-wide wake-UX change (event rows lose their content preview) and is
  **deferred to the eval-cycle close** per the standing sequencing. This change enforces opacity in
  the *templates and tests* so any future (re-pinned) install is opaque by default; it does not touch
  a running service.
- These templates live in `kijito-tools providers/monitor/`. The canonical publish/pin home stays
  `KijitoAI/kijito-inbox-monitor` until fleet producers re-pin (P0-C7 terminal, §4.5). Bringing the
  live flip + the source-repo templates into line rides that transition.
