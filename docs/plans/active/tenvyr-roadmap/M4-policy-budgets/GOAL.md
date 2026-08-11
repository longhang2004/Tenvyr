---
title: "M4 DeepSeek Goal: Policy, Budgets, Approvals, and Authority"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M4-policy-budgets/PLAN.md
  - docs/plans/active/tenvyr-roadmap/M4-policy-budgets/SPEC.md
  - docs/plans/active/tenvyr-roadmap/M4-policy-budgets/VERIFY.md
---

# M4 Goal Mode

## Objective

Implement enforceable hierarchical budgets, pre-action policy, durable approvals,
and correct WAITING semantics without claiming control over opaque reasoning.

## Slice order

### Slice 1 — vocabulary and ledger

Freeze typed integer dimensions, grants/accounts, append-only entries, idempotent
reservation/reconciliation, actual/estimated/unknown semantics, bounds, migration,
and real PostgreSQL concurrency. No policy UI.

### Slice 2 — dispatch/retry/result enforcement

Reserve before work authority, reconcile canonical usage, charge retries/failures,
release only unused amounts, and recover after crash. Preserve existing transaction
owners/lock order and prove 100-way no-overspend.

### Slice 3 — ActionProposal and PolicyDecision

Add bounded hashed proposals and frozen deterministic ALLOW/DENY/REQUIRE_APPROVAL
at interceptable Tenvyr/M3 boundaries. Prove no action occurs first. Do not invent a
general policy language.

### Slice 4 — approvals and WAITING

Implement one-time exact approvals, expiry/conflict/replay rules, branch-aware
WAITING, cancellation race, wakeup/reconcile, and internal queryability. No public
approval route while exposure gate is open.

### Slice 5 — hierarchy and closure

Complete parent subset rules for future Planner/delegation, failure/security matrix,
SDK/executor compatibility, docs/ledger, PostgreSQL twice, and provisional report.

## Rules and stops

Re-read PLAN/SPEC/VERIFY before each slice. Record one status row per slice. Stop
for undefined resource/unknown/approval product semantics or a need for public auth.
Never weaken hard-budget safety, treat unknown as zero, log sensitive proposals, use
WAITING for autonomous delay, or mark Sol verification complete.
