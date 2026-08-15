# Gate-4 option-A sandbox battery — execution protocol (v1)

**Runs only per plan §10 order** (after gate-2 ships post-window and gate-3 — done — is
folded). 2/2 consecutive full green passes required; any finding resets the count. Evidence:
every row gets a timestamped log excerpt + the exact command; scoring is BY-EFFECT
([28458]): session-visible outcomes, never process liveness or self-report.

**Environment:** the staged sandbox `SideProjects/Codex/.qa-tmp/native-wake-probe-20260814/`
(Mac path `/Users/jason/Code/SideProjects/Codex/...`), CODEX_HOME=its `codex-home/`
(auth staged, workspace trusted). Daemon: symlink `~/.codex/packages` into the sandbox home
(measured requirement, TRANSPORT-NOTES.md), then `codex app-server daemon start`.
Helper: `gate4-staging/wake-helper/` (17/17 pre-battery greens on the measured WS-over-UDS
transport). Producer: session-scoped `kijito-inbox-monitor` child via `--producer-cmd`
(gate-3 default shape), watching a REAL persona inbox (persona `codex`, real probe mail).

**Precondition P0 (measured, [28773]):** create the battery's "user session" thread and run
ONE real turn in it (a trivial prompt in the sandbox TUI) so a rollout exists —
`thread/resume` on a turn-less thread fails `-32600 no rollout found`. Record the thread id;
it is the helper's `--thread-id` for every row. The TUI session runs in a dedicated tmux
pane for composer/rendering observations.

## Rows (each pass runs ALL rows; a pass is green only if every row is)

| # | Row | Procedure | Green means |
|---|---|---|---|
| 1 | Happy-path live wake | arm helper (producer child + helper); send probe mail to `codex` | wake turn renders IN THE SESSION TUI: exact-row fetch, id verified, summary; by-effect log (`wake-delivered` + pane capture) |
| 2 | Non-attachment detection | launch a SECOND codex with `-c` override / `--strict-config` (embedded mode, [28502] trap); attempt arm against its context | arm fails LOUDLY (daemon-unavailable or thread-gone) and says so; no silent no-op |
| 3 | Producer-silence controls (3a absent / 3b vanish / 3c child-death) | 3a: arm with no events file and no producer; 3b: delete events file mid-armed; 3c: SIGKILL the owned producer child, file left in place | 3a exit 4 pre-arm, reported; 3b gasp + exit 4; 3c gasp + exit 4 (the silent-tail trap made loud — binding control, assay 7548) |
| 4 | Shared-filter contract | append a non-covered kind (e.g. `heartbeat`) to the stream, then a covered lifecycle kind (`alert`) | non-covered: NO nudge; covered: reconcile wake fires; both from the `_shared` constant, no local filter |
| 5 | Helper lifecycle + DOUBLE-ARM | run arm twice (same session); then kill-the-session control: kill the TUI/daemon thread, observe helper | second arm reports already-armed, exactly one helper (pgrep census); on thread-gone the helper exits 5, no orphan firing into dead/reused threads (census after) |
| 6 | Helper-death visibility ([28733] ruling) | 6a: SIGTERM helper; 6b: SIGKILL helper | 6a: in-session gasp ("catch-up-only") + pidfile reaped; 6b: NO gasp possible — measure the residue (stale pidfile reaped on next arm; death visible at next kijito-start status) and RECORD it in the log as the documented degradation-to-B for SIGKILL only, per the ruling's measured-infeasibility clause |
| 7 | Defer-until-idle (mid-typing / mid-turn) | 7a: type a draft into the composer (do not submit), send probe mail, wait > poll+recheck; 7b **(v2, per argus ruling 7711 — leg (a))**: three legs: (i) by-effect ordering — start a long turn, send probe mid-turn, scrollback must prove the turn completes before the wake renders (no stomp); (ii) real-path defer attempt — arm the helper DURING a long turn (fresh runtime) so `thread/resume` returns the live status; record the observed helper-log sequence (doorbell vs wake-delivered ordering relative to turn end) as a MEASUREMENT of whether the real daemon exposes busy status + idle notifications to a second client; (iii) the helper's own defer layer is certified by the SYNTHETIC forcing test `busy thread defers; idle notification releases the queued wake` (mock daemon `initialStatus:"active"`, doorbell held >poll cycle with zero turn-starts, released exactly once on the idle notification) — run green in the pre-battery suite on both platforms | 7a: composer draft UNTOUCHED; wake turn runs; pane capture proves no stomp; 7b: (i) green iff ordering proven by scrollback; (ii) is a measurement, either outcome recorded honestly (it attributes the real-path serialization mechanism: daemon turn queue vs helper defer); (iii) green iff the forcing test passes in the same battery run. **Row-7b's green claims exactly what each leg executed — no cross-attribution** (the pass-1 defect: a by-effect green misread as the defer layer running). |
| 8 | Wake-turn contract (by-effect) | inspect row-1/row-7 wake turns | turn text is the fixed `_shared` template (prefix, metadata only, no bodies); woken turn does read-only inbox fetch + summary; no send/mutation tools invoked |

**Census discipline:** before and after every row, `pgrep -fl` for helper + producer +
daemon; counts must match expectation; any stray process fails the row.

**Pass bookkeeping:** two consecutive full-battery greens, the second from a fresh sandbox
re-arm (not a re-read of the first's logs). Then: assay certification request with the log +
pane captures; gate-5 ship only after assay's 2/2 read.

**Teardown after battery:** daemon stop, helper stop, producer dead with it; sandbox
archived (never deleted) with the evidence bundle.
