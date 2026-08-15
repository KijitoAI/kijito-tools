# Mode register — P1 migration note (measured-v1 program record)

Filed per assay's build ruling (hive 7056, condition a) so the measured-v1 program sees this
register exists and must be adopted-or-converted at P1 — a provisional institution, never a
silently-permanent one.

**What exists (this PR):** `providers/codex/mode-register.mjs` — an atomic, private,
machine-readable declaration of which of the three FROZEN codex delivery cells
(`codex.tmux-pane`, `codex.app-server-seat`, `codex.attended-notify`) the seat is supposed to be
running (`declared-mode.json`, schema 1, `provisional: true` by contract) — plus
`providers/codex/mode-liveness.mjs`, which turns that declaration into per-mode liveness for the
watchdog's optional `--mode-register` path. It declares and observes; it does not start, stop, or
select. Mutual exclusion stays in `consumer.lock`; delivery stays in the existing driver/controller.
It is NOT a provider↔hive delivery seam and creates no SPI surface.

**The P1 obligation:** when the shared core and provider SPI land (measured-v1 P1), the SPI's own
topology/mode representation becomes the register of record. This file's schema is then either
adopted (SPI reads/writes the same file) or converted (one-shot migration + delete
`mode-register.mjs`). **SPI-WINS is the resolution rule** (assay condition d): any overlap resolves
toward the SPI, and if P0/P1 lands before this PR merges, this PR rebases to consume it.

**Why it did not wait for P1:** the seat and attended-notify cells were certified 2026-08-13 with
"machine mode register" explicitly scoped out as nonexistent; the flip of the canonical codex seat
is gated on it; and the program's P0 is blocked pre-P0 on tracks outside codex's control (argus
seat down, loom idle). Assay ruled the build GREEN as codex-local machinery ([[27943]], hive 7056).
