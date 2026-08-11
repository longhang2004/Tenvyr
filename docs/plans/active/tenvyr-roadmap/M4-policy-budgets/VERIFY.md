---
title: "M4 Verification: Policy, Budgets, Approvals, and Execution Authority"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M4-policy-budgets/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M4 verification contract

## Static architecture audit

- every enforced action decision occurs before the side effect;
- budget is append-only authority, not usage columns/telemetry only;
- no floating money, negative/overflow arithmetic, executable policy string, or
  unknown-as-zero behavior;
- WAITING appears only for external authority/signal;
- opaque runtime actions are not labeled enforced;
- child/grant APIs can only narrow authority.

## Unit tests

- dimension parsing/fixed-unit arithmetic/overflow/rounding;
- reserve/commit/release/adjust and projection rebuild;
- actual/estimated/unknown source/confidence semantics;
- deterministic policy rule evaluation and proposal hashing/bounds;
- approval expiry/idempotency/conflict/scope/policy-version validation;
- branch-aware RUNNING versus WAITING calculation;
- ancestor subset and permission/deadline/depth/fanout rules.

## Real PostgreSQL tests

- 100 concurrent reservations never overspend any ancestor;
- duplicate reserve/reconcile/approval is exactly once; conflicting key retained;
- transaction failure rolls account, ledger, action, and state transition back;
- dispatch reservation and outbox/attempt authority commit consistently;
- result usage reconciliation and terminal application commit consistently;
- approval/cancel/expiry/reconciliation races yield one authority outcome;
- independent runnable branch keeps execution RUNNING;
- restart finds outstanding reservations/approvals and resumes deterministically;
- migration upgrade preserves rows and invents no usage/decision history.

## Integration tests

Exercise Kafka, HTTP, approved M3 executors, retry, timeout, cancellation, and
estimated/unknown usage. Prove action interceptors cannot execute before ALLOW plus
reservation and opaque executors are labeled limited.

## Crash/restart and race scenarios

Crash after reservation before dispatch, after action before usage, during approval
decision, after decision before wakeup, and after result commit. Race sibling spend,
budget increase/cancel, approval/cancel, expiry/approval, and duplicated usage.

## Security review

Test forged/stale/replayed approval, wrong scope/actor/action hash, policy downgrade,
permission escalation, integer exhaustion, high-cardinality dimensions, secret/action
parameter logging, unknown dimension default, and denial bypass. Remote approval is
blocked until external exposure verification.

## Compatibility and docs

M0–M3 scheduling, retries, timeout, cancellation, outbox/inbox, M2 context/artifacts,
and old pipelines without budgets/policy stay green. Update current authority,
WAITING, configuration, ledger, security limitation, and operator documentation.

## Required current commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm test:all
pnpm build:all
pnpm --filter @tenvyr/worker test
python -m pytest sdks/python-worker/tests
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
git diff --check
```

Run PostgreSQL twice sequentially. Add M3 executor, frontend, and exposure/security
deployment gates when those surfaces change.

## Closure gate

SAFE TO CLOSE only if Sol independently proves no overspend/bypass/replay, correct
WAITING and hierarchy, crash/race durability, compatibility, security limitations,
and truthful current docs. DeepSeek's report is provisional.
