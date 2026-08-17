# providers/monitor — import provenance (P0-F29/A29 monitor-foundation)

**Imported by:** argus (monitor steward) · **Date:** 2026-08-17
**Source:** `KijitoAI/kijito-inbox-monitor` → **Destination:** `KijitoAI/kijito-tools` `providers/monitor/`
**Authorization:** steward prep `P0B-MONITOR-FOUNDATION-PREP.md` §4.2 · river CONCUR (hive msg 7986,
2026-08-17: F29 foundation/release/host acceptance) · loom informed (P0 context). Resolver of record:
Kijito memory 28999 + the committed sole-author commit maps.

This manifest is the audit trail because the pre-rewrite lineage was scrubbed by the 2026-08-15
sole-author window and now lives only in the external remap overlay. Where a fact below could not be
re-derived from public history, it is recorded here so tree-equality is auditable post-hoc rather than
asserted.

## Selection (P0-F29 "exact selected source")

| role | SHA | tree |
|---|---|---|
| Frozen pin (pre-rewrite, contract of record) | `bc9110807dc274da8bb4f84e08c111bc33d055dd` | `135417e5d3d821bf29884e4f2ac9f4e19211c8b0` |
| Overlay-resolved (imported selection) | `01a70bc6b26a7450cf38b051a4e6aa32992b1763` | `135417e5d3d821bf29884e4f2ac9f4e19211c8b0` |

**Tree-equality proof (measured independently by argus, 2026-08-17):** the frozen pin and the
overlay-resolved SHA share the **identical tree object** `135417e5d3d821bf29884e4f2ac9f4e19211c8b0`;
`git diff bc9110807dc274da8bb4f84e08c111bc33d055dd 01a70bc6b26a7450cf38b051a4e6aa32992b1763` is empty.
(bc91108 was still resolvable in the local `kijito-inbox-monitor` object store, so this diff was
re-run first-hand rather than cited from the 2026-08-15 measurement.) Importing the literal frozen
SHA was rejected — it would resurrect the authorship the sole-author window exists to have scrubbed.

The contract's "public `3d595914…` strict ancestor" clause refers to the **pre-rewrite** public
lineage; the rewrite destroyed that ancestry in the current object graph (its post-rewrite form is
`d24c8c8ced9be7e2817bcdf52bbbb1377a16d4e9` per the commit map), so it is recorded here, not asserted
as git-verifiable against `01a70bc`.

## Post-import delta (journaled fast-forward, no selection change)

`01a70bc` → `902c21dbd2e93e91b7a6bd801104394577681b5e` (d1_clocks fix, PR #1, assay zero-findings
certification, hive 7715) → `bd04b28616d9a9558a4a6fa3bb5004db08fbf249` (`release: v0.5.0`, npm + PyPI
independently confirmed, fleet deployed).

| role | SHA | tree |
|---|---|---|
| FF target (imported HEAD content) | `bd04b28616d9a9558a4a6fa3bb5004db08fbf249` | `e46c189b0a1192406dc12c2039ef1dbe6500a96a` |

## Landed in kijito-tools (byte-exact, verified via content-addressed subtree hash)

| import step | commit | `HEAD:providers/monitor` tree | matches source tree |
|---|---|---|---|
| import overlay-resolved 01a70bc | `d9be542` | `135417e5d3d821bf29884e4f2ac9f4e19211c8b0` | ✅ = tree(01a70bc) |
| ff to v0.5.0 bd04b28 | `e4a87da` | `e46c189b0a1192406dc12c2039ef1dbe6500a96a` | ✅ = tree(bd04b28) |

Re-verify at any time: `git -C <kijito-tools> rev-parse d9be542:providers/monitor` = the 01a70bc tree,
`git -C <kijito-tools> rev-parse e4a87da:providers/monitor` = the bd04b28 tree. This manifest commit
adds IMPORT-PROVENANCE.md, so the current `providers/monitor` tree differs from `e46c189b…` by exactly
this file.

## Referenced artifacts (hashes)

- Commit map: `evidence/sole-author-remap-20260814/commit-map.inbox-monitor.txt`
  — sha256 `0b1fb8a67165f3bb1146e80e4cc2eeabcf648649cd5fef15fafeacf9edcefc12`
  (contains the line `bc91108… 01a70bc…`).
- Sole-author remap overlay: `Agents/OpenCode/SurfaceArea/SOLE-AUTHOR-SHA-REMAP-OVERLAY.md`
  — sha256 `028199f2d81f14c7e145e744bba21cf593eb3b52819c289156f2b511837deb20`.

## Not done by this import (later P0B sequence)

Old-source transition (kijito-inbox-monitor stays the publish/pin home until fleet producers re-pin —
P0-C7 terminal), `_shared` doorbell + authenticated consumer lease (§4.4), and F29/A29 certify+enforce
of opaque `--no-content` output in both service templates plus the live Mac-producer gap (§4.6) are
tracked separately and not claimed here.
