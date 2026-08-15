# QA companion — codex-hive-user-first-plan-20260814.md

**Specimen:** `codex-hive-user-first-plan-20260814.md` (v2), SHA-256
`d714cfd5aff76a3ddd24a3a523b49884732e68cf320d747478766e670db84cdd`. Bytes FROZEN by this
certification; any byte change resets the count and re-enters review through both reviewers.

## Certification — goal [28506] item (1) MET

| Pass | Reviewer | Verdict | Record |
|---|---|---|---|
| Co-author revision | argus | 1 blocking finding (§2b option-C trigger path) + 1 nit (named double-arm control) → folded in v2 | hive 7450 |
| Co-author pass on v2 | argus | **CLEAN**, banked on `d714cfd5` | hive 7452 |
| External QA on v2 | assay | **CLEAN**, same bytes, sha verified before and after read | hive 7454, assay record [28731] |

Lineage: skeleton co-proposed 7445, reshaped by argus 7446 (shared-seam section, arm-check
primitive spec, measurement criteria, location ruling). v1 sha `c3f1352c…` superseded by v2.
Derives from evaluation v3 sha `9d9f5076…` (its own 2/2 clean record) + Jason's sign-off
[28718] + arming ruling [28714] + doctrine [28680].

## Delegated decision, ruled during external QA (assay 7454 — mechanism, NOT a finding; count unaffected)

**Plan §6 row 5 (helper-death visibility, F4-assay):** the requirement is the **§4a
in-session state transition** (armed-live → catch-up-only, surfaced to the user).
Documented-degradation-to-B is acceptable **only on measured sandbox infeasibility of
in-session surfacing, with that measurement in the battery log** — never as a convenience
fallback. Binding on gate 4 (option-A sandbox battery) execution.

## Standing constraints at certification time

- No kijito-tools commits while the P0 freeze window holds (argus 7446 b; PR #14 was the
  ruled exception). The plan lands at `providers/codex/plans/hive-user-first-plan.md` via
  branch `codex/hive-plan-v1`, PR-only, sole-author commit discipline, after P0 close +
  steward handover.
- Gates 2–7 of plan §10 are authorized by this certification and execute in order.
