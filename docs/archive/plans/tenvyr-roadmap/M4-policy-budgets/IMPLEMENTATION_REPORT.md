---
title: "M4 Implementation Report"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - services/orchestrator/src/domain/budget.ts
  - services/orchestrator/src/domain/policy.ts
  - services/orchestrator/src/domain/approval.ts
  - services/orchestrator/src/services/budget-ledger.service.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/approval.service.ts
  - services/orchestrator/src/services/runtime-recovery.service.ts
---

# M4 implementation report — policy, budgets, approvals

**CLOSED — independent Tech Lead PASS (2026-08-12).** See the
[durable closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).

Date: 2026-08-11
Status: READY for independent SOL verification
Slices: 5/5 complete (S1 vocabulary+ledger, S2 dispatch/retry/result
enforcement, S3 policy decision boundary, S4 approval lifecycle, S5 parent
subset completeness). Provisional until the independent SOL review.

## What M4 delivers

- **Budget vocabulary (M4-S1)** — `domain/budget.ts`: canonical integer
  dimensions (`currency_micros`, `tokens`, `wall_time_ms`), bounded
  scope/action references, `actual|estimated|unknown` semantics, and pure
  projection (`available = grant + adjustments − releases − reserves`;
  committed = evidenced amount, bounded by reserved). Ledger entities +
  migration `1722270006000-MilestoneFourBudgetLedger`: append-only entries
  (reserve/release/commit/adjust), reservations with exactly-once
  idempotency keys (unique constraint; `23505` replay branches to the
  committed decision in a fresh transaction), accounts with parent + CHECK
  child-ceiling-subset, soft ceilings.
- **Atomic enforcement at the existing transaction owners (M4-S2)** —
  reservation commits with claim (attempt + outbox + budget account +
  reserve); insufficient budget is a durable `FAILED` attempt that follows
  the step failure policy; usage reconciles at terminal result application
  (`totalTokens` actual → commit, `costUsdMicros` estimated → commit);
  unused reservation released in the same transaction; retries reserve
  independently; cancel and dispatch-failure release fully. No new
  transaction owners; lock orders preserved.
- **Policy decision boundary (M4-S3)** — `domain/policy.ts`: bounded
  `ActionProposal` and immutable `PolicyDecision`; versioned snapshots
  frozen at claim (rotation → deterministic safe failure
  `POLICY_VERSION_CONFLICT`); append-only `policy_decisions` committed
  atomically with the action outcome; `ALLOW` alone grants no authority
  (the budget reserve is still required). Rules: actionType (dispatch/
  cancel/approval-outcome), scope/subject matchers, executors, effects
  `ALLOW|DENY|REQUIRE_APPROVAL`, immutable evidence, `default deny`.
- **Approval lifecycle (M4-S4)** — durable `ApprovalRequest` (unique
  proposalId per intercepted action) with `PENDING → APPROVED|DENIED|
EXPIRED`; approve resumes the SAME attempt (budget reserve + single
  outbox row; replay never re-executes); deny/expiry follow the step
  failure policy; the recovery sweep owns due expiry; guarded
  approval-outcome application (only `WAITING` attempts can be failed by
  an approval outcome; cancel/result races never overwritten).
- **Hierarchy completeness (M4-S5)** — plan-declared parent scopes
  activated at claim (operator-created parent required; execution grant
  must be a subset of the direct parent grant); `adjust` propagates
  chain-wide with opposite-signed ancestor deltas (child top-up debits
  ancestors; rejected when any ancestor lacks the room); the dynamic
  boundary — every reserve validates the whole chain — is the invariant;
  no budget path mints availability across the hierarchy.

## Verification (final state)

- Unit: orchestrator 519 passed / 161 skipped (PG) / 0 failed (domain
  budget 14, policy 7, approval 7, ledger service, notify-cancel…).
- Real PostgreSQL (tenvyr_roadmap_test): 679/680 ×2 sequential —
  M4-S1 13, M4-S2 10, M4-S3 5, M4-S4 8, M4-S5 9 tests, incl. 100-way
  concurrent no-overspend, exactly-once replay under contention,
  release ≤ unused, cancel-vs-approval races, migration repeat-safety,
  round-trip through the real PipelineService, direct-parent subset.
- test:all green (contracts 65, worker 199, host 31, orchestrator 519,
  gateway, agents, example); build:all 15 packages; verify:docs 86
  files / 32 capabilities; verify:identity 0 violations; git diff --check.
- Real hosts: local-executor-host 31/31 + the real
  orchestrator→host loopback (fixed command with secret env, signed
  callback, canonical result applied) — 1/1.

## Known limitations (explicit)

- Adjust is not idempotency-keyed (operator correction; bounded by the
  caller's `actionRef` evidence). Retried adjusts double-apply — the
  operator's responsibility, documented in `docs/architecture/
control-plane.md`.
- Tenant/plan accounts are operator-created; the pipeline can only refer
  to a parent. Grant rotation is `adjust`, not a separate API.
- The static "child available ≤ ancestor available" inequality need not
  hold after an operator top-up; the DYNAMIC boundary (reserve validates
  all ancestors) is the enforced invariant.
- Budgets are opt-in per pipeline; un-budgeted pipelines run unchanged.
- 100ms wall-time host test is load-sensitive under `test:all` parallel
  runs (flaked once; deterministic standalone).

## Independent closure

**PASS — CLOSED 2026-08-12.** Independent review verified the append-only
ledger, hierarchical reservation boundary, policy snapshot/decision authority,
approval race semantics, and migration behavior. No M4 production correction
was required. Final evidence is in the
[durable M3–M7 closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
